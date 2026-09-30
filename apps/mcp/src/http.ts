import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpOAuth } from "@budget/api/auth";
import { DomainError } from "@budget/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { buildServer, type McpDeps } from "./server.js";

/**
 * ADR-066: OAuth per the MCP authorization spec, when MCP_OAUTH_KEY is set. This service is the
 * protected resource, and its own authorization server for discovery, registration and tokens;
 * the authorization endpoint (sign-in and consent) is on the app, behind IAP (APP_BASE_URL).
 */
export interface OAuthConfig {
  oauth: McpOAuth;
  /** This service's public URL (MCP_PUBLIC_URL). */
  publicUrl: string;
  /** The app's URL, where people sign in (APP_BASE_URL). */
  appUrl: string;
}

/**
 * `POST /mcp`: Streamable HTTP in stateless mode, one server and transport per request (spec §16).
 * The bearer token reaches the tools as `authInfo`; each tool verifies it. `GET /healthz`.
 */
export function buildHttp(deps: McpDeps, oauth: OAuthConfig | null = null): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
  if (oauth) registerOAuth(app, oauth);
  const challenge = oauth ? `Bearer realm="budget-os", resource_metadata="${oauth.publicUrl}/.well-known/oauth-protected-resource"` : 'Bearer realm="budget-os"';
  app.post("/mcp", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const token = /^Bearer (.+)$/i.exec(header)?.[1];
    if (!token) {
      return reply.code(401).header("www-authenticate", challenge).send({ code: "UNAUTHENTICATED", message: "Bearer token required" });
    }
    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no sessionIdGenerator: stateless
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    // The SDK declares optional callbacks without | undefined; this is its own transport.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(Object.assign(request.raw, { auth: { token, clientId: "budget-os", scopes: [] } }), reply.raw, request.body);
  });
  // Stateless: no SSE stream to resume and no session to delete.
  app.get("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send());
  app.delete("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send());
  return app;
}

function registerOAuth(app: FastifyInstance, { oauth, publicUrl, appUrl }: OAuthConfig): void {
  // Token requests are form-encoded (RFC 6749 §4.1.3).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
  const resource = { resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl], bearer_methods_supported: ["header"], scopes_supported: ["budget:read"] };
  const server = {
    issuer: publicUrl,
    authorization_endpoint: `${appUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["budget:read"],
  };
  app.get("/.well-known/oauth-protected-resource", async () => resource);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => resource);
  app.get("/.well-known/oauth-authorization-server", async () => server);
  app.get("/.well-known/openid-configuration", async () => server);
  const oauthError = (reply: import("fastify").FastifyReply, error: string, description: string, status = 400) => reply.code(status).header("cache-control", "no-store").send({ error, error_description: description });
  app.post("/oauth/register", async (request, reply) => {
    const body = (request.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    try {
      const clientId = await oauth.registerClient({ redirectUris: uris, name: typeof body.client_name === "string" ? body.client_name : "MCP client" });
      return reply.code(201).send({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}) });
    } catch (e) {
      return oauthError(reply, "invalid_redirect_uri", e instanceof Error ? e.message : String(e));
    }
  });
  app.post("/oauth/token", async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string | undefined>;
    try {
      if (b["grant_type"] === "authorization_code") return reply.header("cache-control", "no-store").send(await oauth.exchangeCode(b["code"] ?? "", b["client_id"] ?? "", b["redirect_uri"] ?? "", b["code_verifier"] ?? ""));
      if (b["grant_type"] === "refresh_token") return reply.header("cache-control", "no-store").send(await oauth.refresh(b["refresh_token"] ?? "", b["client_id"] ?? ""));
      return oauthError(reply, "unsupported_grant_type", "authorization_code or refresh_token");
    } catch (e) {
      return oauthError(reply, "invalid_grant", e instanceof DomainError ? e.message : "invalid grant");
    }
  });
}
