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

/**
 * What an orchestrator reads at the handshake (docs/DATA_PLAN.md §7, D-010): how to start, how
 * filters and amounts work, and which words mean what, so it asks the right tool the first time.
 */
export const INSTRUCTIONS = [
  "Budget OS: marketing budgets (envelopes) by granularity (country, platform, channel, objective…), their approvals, actual and projected spend, KPIs against targets, snapshots and closes. Everything here is read-only and scoped to the caller.",
  "Start with list_workspaces, then describe_workspace(workspaceId): it returns the calendar, every granularity with its values and how much budget each holds, the hierarchies, the metric library with its formulas and the words people use (tCPA means the CPA metric), the headline numbers, counts, snapshots and freshness. Use its keys and codes; never guess a code.",
  "query_budgets answers most questions: filter is a FilterGroup over granularity keys and codes; groupBy takes granularity keys; measures include budget, actual, projected, remaining, pace_index, spend_to_date_pct, projected_close_pct; targets takes metric keys (cpa, roas…) and returns each metric's actual against its target. Add is_leaf = true to a filter to count leaf budgets once; the workspace's budget is its top-level budgets (parent_id is_empty) with subtree: true.",
  "Amounts are decimal strings in the workspace's reporting currency unless a row says otherwise. Ratios (CPA, ROAS, CTR…) are computed from counts at every level: never add them up yourself.",
  "History: asOf reads the budgets approved at an instant; list_baselines lists snapshots saved by hand (a plan, a close); compare_budgets says how budgets moved since one; get_baseline shows one in full; compareTo in query_budgets adds budget_baseline and the change. get_decision_timeline shows who changed what and why.",
  "Prompts: pacing_review, since_snapshot and unmatched_spend run the usual questions with live numbers.",
].join("\n");

export function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "budget-os", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  /** Authenticate, authorize, rate-limit, audit, then read: every tool and prompt goes through here. */
  async function readThrough(tool: string, permission: Permission, workspaceId: string | null, extra: Extra, args: unknown, fn: (auth: AuthContext) => Promise<unknown>, requestId: string, callId: string): Promise<{ data: unknown; dataVersion: number | null }> {
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
    return { data, dataVersion };
  }

  async function run(tool: string, permission: Permission, workspaceId: string | null, extra: Extra, args: unknown, fn: (auth: AuthContext) => Promise<unknown>): Promise<CallToolResult> {
    const callId = randomUUID();
    const requestId = `mcp-${callId}`;
    try {
      const { data, dataVersion } = await readThrough(tool, permission, workspaceId, extra, args, fn, requestId, callId);
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
  // query_budgets' arguments, each saying where its keys and codes come from (D-011).
  const QUERY_SHAPE = {
    ...QueryRequest.shape,
    filter: QueryRequest.shape.filter.describe("FilterGroup: { logic: 'and'|'or', children: [predicate | group] }; a predicate is { field: { kind: 'dimension', key } | { kind: 'attr', key: 'is_leaf'|'status'|'parent_id'|'tag'… } | { kind: 'measure', key }, op, value }. Keys and codes from describe_workspace."),
    groupBy: QueryRequest.shape.groupBy.describe("Granularity keys from describe_workspace (dimensions[].key), outermost first."),
    measures: QueryRequest.shape.measures.describe("budget, budget_in_period, actual, projected, remaining, variance_abs, variance_pct, pace_index, projected_close_pct, spend_to_date_pct; with compareTo also budget_baseline, budget_change_abs, budget_change_pct."),
    targets: QueryRequest.shape.targets.describe("Metric keys (describe_workspace metrics[].key, e.g. cpa, roas): each row gets the metric's actual, its target and actual/target. The way to ask for CPA or tCPA."),
    period: QueryRequest.shape.period.describe("{ kind: 'relative', preset: 'current_year'|'current_quarter'|… } or { kind: 'fiscal', key: 'FY2026'|'2026-Q3'|'2026-09' } or { kind: 'range', start, end }."),
    compareTo: QueryRequest.shape.compareTo.describe("{ baselineId } from list_baselines, or { asOf }: adds budget_baseline and the change measures."),
    subtree: QueryRequest.shape.subtree.describe("true: each row's spend includes everything under it (use with parent_id is_empty for the workspace's headline)."),
    includeDemo: QueryRequest.shape.includeDemo.describe("Demo budgets and demo facts (spec §27) are excluded by default; true includes them too."),
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool("list_workspaces", { description: "Workspaces the caller can access, with their roles and permissions", inputSchema: {}, annotations: readOnly }, async (args, extra) =>
    run("list_workspaces", "authenticated", null, extra, args, async (auth) => (await q.getMe(deps.prisma, deps.auth.access, auth)).workspaces),
  );

  server.registerTool(
    "describe_workspace",
    {
      description:
        "Call this first. One workspace in full: its calendar (fiscal year, this quarter), every granularity with its values and the fiscal year's budget by value, the hierarchies, the metric library with formulas and the words people use for each metric (tCPA → cpa), the headline (budget, spend, pace, projected close, as Overview shows it), counts (budgets, leaves, values in use, approvals waiting, open alerts), snapshots, closes, data freshness, and hints for building query_budgets calls.",
      inputSchema: { workspaceId: ws },
      annotations: readOnly,
    },
    async (args, extra) => run("describe_workspace", "envelope.read", args.workspaceId, extra, args, (auth) => q.describeWorkspace(deps.prisma, auth)),
  );

  server.registerTool(
    "describe_dimensions",
    { description: "Dimension registry with values and hierarchy templates. Call before building filters: FilterGroup dimension keys and value codes come from here.", inputSchema: { workspaceId: ws }, annotations: readOnly },
    async (args, extra) => run("describe_dimensions", "workspace.member", args.workspaceId, extra, args, (auth) => q.describeRegistry(deps.prisma, auth)),
  );

  server.registerTool(
    "query_budgets",
    {
      description:
        "Budget vs actual vs projected at any grouping (the planner). filter is the FilterGroup AST over describe_dimensions keys; groupBy dimension keys; one page per call (cursor). asOf reads the budgets approved at an instant; compareTo ({ baselineId } from list_baselines, or { asOf }) adds the measures budget_baseline, budget_change_abs and budget_change_pct.",
      inputSchema: QUERY_SHAPE,
      annotations: readOnly,
    },
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
    "list_baselines",
    {
      description: "Snapshots of the budget saved by hand (Phase E): the plan as agreed, a close, or any moment someone kept. Each has a name, kind (plan, close, other), what it holds (the workspace, a filter's budgets or one budget's subtree), when it was taken and its total. envelopeId lists the ones that hold that budget, with what each kept for it.",
      inputSchema: { workspaceId: ws, includeArchived: z.boolean().optional(), envelopeId: z.string().uuid().optional() },
      annotations: readOnly,
    },
    async (args, extra) => run("list_baselines", "envelope.read", args.workspaceId, extra, args, (auth) => q.listBaselines(deps.prisma, auth, defined({ includeArchived: args.includeArchived ? "true" : undefined, envelopeId: args.envelopeId }))),
  );

  server.registerTool(
    "get_baseline",
    {
      description: "One snapshot in full: its header and its frozen rows as the tree they were saved in (name, parent, granularities, amount then, amount now). Use it to read what the budget was at that moment; compare_budgets says how it moved.",
      inputSchema: { workspaceId: ws, baselineId: z.string().uuid(), limit: z.number().int().min(1).max(20_000).optional() },
      annotations: readOnly,
    },
    async (args, extra) => run("get_baseline", "envelope.read", args.workspaceId, extra, args, (auth) => q.baselineRows(deps.prisma, auth, args.baselineId, defined({ limit: args.limit === undefined ? undefined : String(args.limit) }))),
  );

  server.registerTool(
    "compare_budgets",
    {
      description: "How budgets moved since a snapshot: against now, or against a later snapshot (against = its id). Totals and the change (amount and %), how many budgets went up, down, are new, were removed or ended, the change per granularity, and the biggest movers.",
      inputSchema: { workspaceId: ws, baselineId: z.string().uuid(), against: z.string().uuid().optional(), limit: z.number().int().min(1).max(200).optional() },
      annotations: readOnly,
    },
    async (args, extra) => run("compare_budgets", "envelope.read", args.workspaceId, extra, args, (auth) => q.baselineReport(deps.prisma, auth, args.baselineId, defined({ against: args.against, limit: args.limit === undefined ? undefined : String(args.limit) }))),
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

  server.registerResource(
    "glossary",
    new ResourceTemplate("budget://workspace/{workspaceId}/glossary", { list: undefined }),
    { description: "The workspace's words: granularities, metrics (and their synonyms, e.g. tCPA for CPA), ratio words, statuses and concepts", mimeType: "application/json" },
    async (uri, variables, extra) => {
      const workspaceId = String(variables["workspaceId"]);
      const result = await run("glossary", "envelope.read", ws.safeParse(workspaceId).success ? workspaceId : "invalid", extra, { workspaceId }, (auth) => q.workspaceGlossary(deps.prisma, auth));
      const first = result.content[0];
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: first && first.type === "text" ? first.text : "{}" }] };
    },
  );

  // Prompts (D-012): the usual questions, with the numbers read live under the caller's scope.
  const prompt = async (name: string, workspaceId: string, extra: Extra, args: unknown, ask: string, read: (auth: AuthContext) => Promise<unknown>, permission: Permission = "envelope.read") => {
    const callId = randomUUID();
    let body: string;
    try {
      const { data } = await readThrough(`prompt.${name}`, permission, workspaceId, extra, args, read, `mcp-${callId}`, callId);
      body = JSON.stringify(data);
    } catch (error) {
      body = JSON.stringify(error instanceof DomainError ? { error: { code: error.code, message: error.message } } : { error: { code: "INTERNAL", message: "The data could not be read" } });
    }
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `${ask}\n\nData (read just now, JSON):\n${body}` } }] };
  };

  server.registerPrompt(
    "pacing_review",
    { title: "Pacing review", description: "Which budgets are over or under pace this period, and why it matters", argsSchema: { workspaceId: ws, period: z.enum(["current_month", "current_quarter", "current_year"]).optional() } },
    async (args, extra) =>
      prompt("pacing_review", args.workspaceId, extra, args, `Review pacing for ${args.period ?? "current_quarter"}. Say the headline in one line (budget, spend, pace), then the budgets most over pace and most under pace with their numbers, then the open alerts. Pace 1.00 is on plan. Use only the data below; call query_budgets for more detail.`, async (auth) => {
        const period = { kind: "relative" as const, preset: args.period ?? ("current_quarter" as const) };
        const leaves = { logic: "and" as const, children: [{ field: { kind: "attr" as const, key: "is_leaf" as const }, op: "eq" as const, value: true }, { field: { kind: "attr" as const, key: "status" as const }, op: "neq" as const, value: "ARCHIVED" }] };
        const measures = ["budget", "actual", "pace_index", "projected_close_pct"] as const;
        const over = await q.runQuery(deps.prisma, auth, { workspaceId: args.workspaceId, filter: leaves, measures: [...measures], period, sort: [{ key: "pace_index", dir: "desc" }], limit: 10 });
        const under = await q.runQuery(deps.prisma, auth, { workspaceId: args.workspaceId, filter: leaves, measures: [...measures], period, sort: [{ key: "pace_index", dir: "asc" }], limit: 10 });
        const slim = (r: { rows: Array<{ path: string[]; measures: Record<string, string | null> }> }) => r.rows.map((x) => ({ budget: x.path.join(" › "), ...x.measures }));
        return { period, totals: over.totals, mostOverPace: slim(over), mostUnderPace: slim(under), openAlerts: ((await q.listAlerts(deps.prisma, auth, { limit: 20 })) as unknown[]).length };
      }),
  );

  server.registerPrompt(
    "since_snapshot",
    { title: "What moved since a snapshot", description: "How budgets changed since a saved snapshot (the latest plan when none is given)", argsSchema: { workspaceId: ws, baselineId: z.string().uuid().optional() } },
    async (args, extra) =>
      prompt("since_snapshot", args.workspaceId, extra, args, "Explain how the budget moved since this snapshot: the total change in amount and %, how many budgets went up, down, are new, were removed or ended, where by granularity the change is concentrated, and the biggest movers. Use only the data below.", async (auth) => {
        const list = (await q.listBaselines(deps.prisma, auth, {})).baselines;
        const snap = args.baselineId ? list.find((b) => b.id === args.baselineId) : (list.find((b) => b.kind === "plan") ?? list[0]);
        if (!snap) throw new DomainError("NOT_FOUND", "No snapshot has been saved in this workspace yet");
        return { snapshot: { id: snap.id, name: snap.name, kind: snap.kind, asOf: snap.asOf }, report: await q.baselineReport(deps.prisma, auth, snap.id, { limit: 15 }) };
      }),
  );

  server.registerPrompt(
    "unmatched_spend",
    { title: "Spend without a budget", description: "Spend the sources loaded that matches no budget, by granularities", argsSchema: { workspaceId: ws } },
    async (args, extra) =>
      prompt("unmatched_spend", args.workspaceId, extra, args, "List the spend that matches no budget, largest first, by its granularities, and suggest which budget each group probably belongs to (or that a budget is missing). Use only the data below.", async (auth) => ({ unmatched: await q.listUnmatched(deps.prisma, auth, "50") }), "source.manage"),
  );

  return server;
}
