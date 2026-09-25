import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { authenticate, authorize, type AuthContext, type AuthDeps } from "@budget/api/auth";
import * as q from "@budget/api/queries";
import { audit, withTenant } from "@budget/db";
import { DomainError, FilterGroup, PeriodSpec, QueryRequest } from "@budget/domain";
import type { ObjectStore } from "@budget/workers";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { log } from "./log.js";
import type { RateLimiter } from "./rate-limit.js";

/**
 * The read-only MCP server (spec §16, plan §6.4, ADR-019). Every tool authenticates the caller's
 * bearer token as the API does (actor type `mcp`), checks the tool's permission, spends one unit
 * of the per-user rate limit, writes one `audit_event(actor_type='mcp', action='mcp.<tool>')`, and
 * runs API **queries** only (never `commands/`, see readonly.test.ts). Scope and RLS are the
 * caller's own. Results carry `dataVersion` and `dataAsOf`.
 */

export interface McpDeps {
  /** Connected as `budget_mcp`: SELECT everywhere RLS allows, INSERT on audit_event only. */
  prisma: PrismaClient;
  auth: AuthDeps;
  limiter: RateLimiter;
  store: ObjectStore;
}

type Permission = Parameters<typeof authorize>[1];
interface Extra {
  authInfo?: { token: string } | undefined;
}

const text = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const failure = (code: string, message: string, details?: unknown): CallToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ code, message, ...(details === undefined ? {} : { details }) }) }] });
/** Drops undefined fields (exactOptionalPropertyTypes; query parsers treat absent and undefined alike). */
const defined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };

export function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "budget-os", version: "1.0.0" });

  async function run(tool: string, permission: Permission, workspaceId: string | null, extra: Extra, args: unknown, fn: (auth: AuthContext) => Promise<unknown>): Promise<CallToolResult> {
    const callId = randomUUID();
    const requestId = `mcp-${callId}`;
    try {
      const token = extra.authInfo?.token;
      if (!token) throw new DomainError("UNAUTHENTICATED", "Bearer token required");
      const auth = await authenticate(deps.auth, { authorization: `Bearer ${token}`, workspaceId, requestId, actorType: "mcp" });
      authorize(auth, permission);
      await deps.limiter.take(auth.user.id);
      const dataVersion = await withTenant(deps.prisma, auth.ctx, async (tx) => {
        const argText = JSON.stringify(args ?? {});
        await audit(tx, { workspaceId, actorId: auth.user.id, actorType: "mcp", action: `mcp.${tool}`, entityType: "mcp_call", entityId: callId, after: { tool, args: argText.length > 4000 ? `${argText.slice(0, 4000)}…` : JSON.parse(argText) }, requestId });
        if (workspaceId === null) return null;
        const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
        return Number((ws?.settings as { dataVersion?: number } | null)?.dataVersion ?? 0);
      });
      const data = await fn(auth);
      log.info({ tool, requestId, workspaceId, actorId: auth.user.id }, "mcp tool");
      return text({ data, dataVersion, dataAsOf: new Date().toISOString() });
    } catch (error) {
      if (error instanceof DomainError) {
        log.warn({ tool, requestId, workspaceId, code: error.code }, "mcp tool refused");
        return failure(error.code, error.message, error.details);
      }
      log.error({ err: error, tool, requestId, workspaceId }, "mcp tool failed");
      return failure("INTERNAL", "The tool failed; see the server log", { requestId });
    }
  }

  const ws = z.string().uuid();
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool("list_workspaces", { description: "Workspaces the caller can access, with their roles and permissions", inputSchema: {}, annotations: readOnly }, async (args, extra) =>
    run("list_workspaces", "authenticated", null, extra, args, async (auth) => (await q.getMe(deps.prisma, deps.auth.access, auth)).workspaces),
  );

  server.registerTool(
    "describe_dimensions",
    { description: "Dimension registry with values and hierarchy templates. Call before building filters: FilterGroup dimension keys and value codes come from here.", inputSchema: { workspaceId: ws }, annotations: readOnly },
    async (args, extra) => run("describe_dimensions", "workspace.member", args.workspaceId, extra, args, (auth) => q.describeRegistry(deps.prisma, auth)),
  );

  server.registerTool(
    "query_budgets",
    { description: "Budget vs actual vs projected at any grouping (the planner). filter is the FilterGroup AST over describe_dimensions keys; groupBy dimension keys; one page per call (cursor).", inputSchema: QueryRequest.shape, annotations: readOnly },
    async (args, extra) => run("query_budgets", "envelope.read", args.workspaceId, extra, args, (auth) => q.runQuery(deps.prisma, auth, args)),
  );

  server.registerTool(
    "get_budget",
    { description: "One envelope: approved version and draft (as of a time if given), targets, open alerts and threads.", inputSchema: { workspaceId: ws, envelopeId: z.string().uuid(), asOf: z.string().datetime().optional() }, annotations: readOnly },
    async (args, extra) =>
      run("get_budget", "envelope.read", args.workspaceId, extra, args, async (auth) => ({
        envelope: await q.getEnvelope(deps.prisma, auth, args.envelopeId, args.asOf),
        targets: await q.envelopeTargets(deps.prisma, auth, args.envelopeId),
        alerts: await q.listAlerts(deps.prisma, auth, { envelopeId: args.envelopeId }),
        threads: await q.listThreads(deps.prisma, auth, { anchorType: "envelope", anchorId: args.envelopeId }),
      })),
  );

  server.registerTool(
    "get_pacing",
    { description: "Pacing per envelope (budget, actual, projected, pace index, spend-to-date and projected close) with open alert counts and totals, for a filter and period (default: the fiscal year).", inputSchema: { workspaceId: ws, filter: FilterGroup.optional(), period: PeriodSpec.optional(), limit: z.number().int().min(1).max(1000).optional(), cursor: z.string().optional() }, annotations: readOnly },
    async (args, extra) =>
      run("get_pacing", "envelope.read", args.workspaceId, extra, args, (auth) =>
        q.pacingView(deps.prisma, auth, defined({ filter: args.filter ? JSON.stringify(args.filter) : undefined, period: args.period ? JSON.stringify(args.period) : undefined, limit: args.limit === undefined ? undefined : String(args.limit), cursor: args.cursor })),
      ),
  );

  server.registerTool(
    "query_targets",
    { description: "Budget and KPI targets (envelope- and filter-scoped) with their current version; inheritance is resolved by query_budgets targets.", inputSchema: { workspaceId: ws, metricKey: z.string().optional(), envelopeId: z.string().uuid().optional(), scopeType: z.enum(["envelope", "filter"]).optional() }, annotations: readOnly },
    async (args, extra) => run("query_targets", "target.read", args.workspaceId, extra, args, (auth) => q.listTargets(deps.prisma, auth, defined({ metric: args.metricKey, envelopeId: args.envelopeId, scopeType: args.scopeType }))),
  );

  server.registerTool(
    "search",
    { description: 'Global search with qualifiers, e.g. "brazil meta country:BR status:pending" or "type:tag q3".', inputSchema: { workspaceId: ws, query: z.string().max(500), types: z.array(z.string()).optional(), limit: z.number().int().min(1).max(50).default(10) }, annotations: readOnly },
    async (args, extra) => run("search", "workspace.member", args.workspaceId, extra, args, (auth) => q.search(deps.prisma, auth, defined({ q: args.query, types: args.types?.join(","), limit: String(args.limit) }))),
  );

  server.registerTool(
    "list_approvals",
    { description: "Approval requests with their chain and decisions; assignee @me keeps the ones the caller may decide.", inputSchema: { workspaceId: ws, status: z.array(z.string()).optional(), assignee: z.literal("@me").optional(), limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }, annotations: readOnly },
    async (args, extra) =>
      run("list_approvals", "workspace.member", args.workspaceId, extra, args, (auth) => q.listApprovals(deps.prisma, auth, defined({ status: args.status?.join(","), assignee: args.assignee ? "me" : undefined, limit: String(args.limit), cursor: args.cursor }))),
  );

  server.registerTool(
    "get_decision_timeline",
    { description: "An envelope's lineage: versions, approvals, comments, alerts, ingestion and closures, newest first.", inputSchema: { workspaceId: ws, envelopeId: z.string().uuid(), limit: z.number().int().min(1).max(500).default(100), cursor: z.string().optional() }, annotations: readOnly },
    async (args, extra) => run("get_decision_timeline", "envelope.read", args.workspaceId, extra, args, (auth) => q.getTimeline(deps.prisma, auth, args.envelopeId, defined({ limit: String(args.limit), cursor: args.cursor }))),
  );

  server.registerTool(
    "list_alerts",
    { description: "Pacing alerts, newest first (default: the open ones), optionally for a FilterGroup.", inputSchema: { workspaceId: ws, filter: FilterGroup.optional(), status: z.array(z.enum(["OPEN", "ACKNOWLEDGED", "SNOOZED", "RESOLVED"])).optional(), limit: z.number().int().min(1).max(500).default(100) }, annotations: readOnly },
    async (args, extra) =>
      run("list_alerts", "envelope.read", args.workspaceId, extra, args, (auth) => q.listAlerts(deps.prisma, auth, defined({ filter: args.filter ? JSON.stringify(args.filter) : undefined, status: args.status?.join(","), limit: args.limit }))),
  );

  server.registerTool(
    "list_threads",
    { description: "Threads and comments on an entity (envelope, cell, target, alert, approval_request).", inputSchema: { workspaceId: ws, anchorType: z.string(), anchorId: z.string().uuid() }, annotations: readOnly },
    async (args, extra) => run("list_threads", "workspace.member", args.workspaceId, extra, args, (auth) => q.listThreads(deps.prisma, auth, { anchorType: args.anchorType, anchorId: args.anchorId })),
  );

  server.registerTool("list_tags", { description: "The workspace's tag vocabulary with usage counts.", inputSchema: { workspaceId: ws }, annotations: readOnly }, async (args, extra) =>
    run("list_tags", "workspace.member", args.workspaceId, extra, args, (auth) => q.listTags(deps.prisma, auth)),
  );

  server.registerTool(
    "get_closure",
    { description: "A period's latest closure (e.g. 2026-Q1) with its frozen variance report and registry snapshot.", inputSchema: { workspaceId: ws, periodKey: z.string().max(10) }, annotations: readOnly },
    async (args, extra) => run("get_closure", "envelope.read", args.workspaceId, extra, args, (auth) => q.closureByPeriod(deps.prisma, auth, args.periodKey)),
  );

  server.registerTool(
    "export_csv",
    { description: "Runs a query over every page and returns a signed URL to its CSV (expires in 1 hour).", inputSchema: QueryRequest.shape, annotations: { ...readOnly, idempotentHint: false } },
    async (args, extra) => run("export_csv", "export.run", args.workspaceId, extra, args, (auth) => q.exportCsvLink(deps.prisma, deps.store, auth, args)),
  );

  server.registerResource(
    "registry",
    new ResourceTemplate("budget://workspace/{workspaceId}/registry", { list: undefined }),
    { description: "Dimension registry and hierarchy templates of a workspace", mimeType: "application/json" },
    async (uri, variables, extra) => {
      const workspaceId = String(variables["workspaceId"]);
      const result = await run("registry", "workspace.member", ws.safeParse(workspaceId).success ? workspaceId : "invalid", extra, { workspaceId }, (auth) => q.describeRegistry(deps.prisma, auth));
      const first = result.content[0];
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: first && first.type === "text" ? first.text : "{}" }] };
    },
  );

  return server;
}
