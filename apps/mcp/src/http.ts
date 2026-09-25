import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { buildServer, type McpDeps } from "./server.js";

/**
 * `POST /mcp`: Streamable HTTP in stateless mode, one server and transport per request (spec §16).
 * The bearer token reaches the tools as `authInfo`; each tool verifies it. `GET /healthz`.
 */
export function buildHttp(deps: McpDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.get("/healthz", async () => ({ ok: true }));
  app.post("/mcp", async (request, reply) => {
    const header = request.headers.authorization ?? "";
    const token = /^Bearer (.+)$/i.exec(header)?.[1];
    if (!token) {
      return reply.code(401).header("www-authenticate", 'Bearer realm="budget-os"').send({ code: "UNAUTHENTICATED", message: "Bearer token required" });
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
