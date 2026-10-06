import { createHash } from "node:crypto";
import { DomainError } from "@budget/domain";
import { withIdempotency, type IdempotencyRequest, type TenantContext, type WithIdempotencyOptions } from "@budget/db";
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaClient } from "@prisma/client";
import { PinoLogger } from "nestjs-pino";
import { from, lastValueFrom, type Observable } from "rxjs";
import { PERMISSION_KEY, type RoutePermission } from "./permission.decorator.js";
import type { TenantRequest } from "./tenant.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** A key is 1–255 printable ASCII characters without spaces (a UUID from the web client). */
const KEY = /^[\x21-\x7e]{1,255}$/;
/** Slack gives up after 3 s; a retry that finds its original still running is acknowledged within that. */
const SLACK_WAIT_MS = 2_500;

interface IdempotentRequest extends TenantRequest {
  url?: string;
  body?: unknown;
  rawBody?: string;
}

/** The parts of Fastify's reply this interceptor uses. */
interface Reply {
  statusCode: number;
  status(code: number): unknown;
  header(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}

interface Plan {
  ctx: TenantContext;
  req: IdempotencyRequest;
  slack: boolean;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const pathOf = (url: string | undefined) => (url ?? "/").split("?")[0] ?? "/";

/**
 * W3-2 (audit I-6, spec §17, ADR-0081): `Idempotency-Key` on every mutating route. Registered
 * after TenantInterceptor and RateLimitInterceptor (common.module.ts), so `request.tenant` is set
 * and a rate-limited request never claims a key. Without the header a request runs exactly as
 * before. With it, `withIdempotency` (@budget/db) claims the key for (workspace or org, person),
 * runs the handler, and stores its status and JSON body; a repeat replays them with
 * `Idempotent-Replayed: true`. Slack's signed routes need no header: the key is the request's
 * trigger_id, scoped to the Slack team, so Slack's own retries (X-Slack-Retry-Num) replay.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const method = (request.method ?? "GET").toUpperCase();
    if (SAFE_METHODS.has(method)) return next.handle();
    const permission = this.reflector.getAllAndOverride<RoutePermission | undefined>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const plan = permission === "slack.signed" ? slackPlan(request, method) : tenantPlan(request, method);
    if (plan === null) return next.handle();
    return from(this.run(plan, context.switchToHttp().getResponse<Reply>(), next));
  }

  private async run(plan: Plan | Error, reply: Reply, next: CallHandler): Promise<unknown> {
    if (plan instanceof Error) throw plan;
    const opts: WithIdempotencyOptions = {
      onBookkeepingError: (err, step) => this.logger.error({ err, step, idempotencyRoute: plan.req.route }, "idempotency key bookkeeping failed; a retry with this key may wait for the in-flight lease"),
    };
    if (plan.slack) {
      opts.waitMs = SLACK_WAIT_MS;
      opts.onStillInFlight = () => ({ status: 200, body: undefined });
    }
    const result = await withIdempotency(
      this.prisma,
      plan.ctx,
      plan.req,
      async () => {
        const body: unknown = await lastValueFrom(next.handle(), { defaultValue: undefined });
        return { status: reply.statusCode, body, replayable: replayable(body, reply) };
      },
      opts,
    );
    if (result.replayed) {
      reply.status(result.status);
      reply.header("idempotent-replayed", "true");
    }
    return result.body;
  }
}

/** A key on a tenant route: scoped to the workspace (or, with none, the org) and the acting person. */
function tenantPlan(request: IdempotentRequest, method: string): Plan | Error | null {
  const raw = request.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined) return null;
  if (!KEY.test(key)) return new DomainError("VALIDATION", "Idempotency-Key must be 1-255 printable characters without spaces");
  const tenant = request.tenant;
  const actorId = tenant?.ctx.userId ?? null;
  if (tenant === undefined || actorId === null) return null;
  const { workspaceId, orgId } = tenant.ctx;
  const route = `${method} ${pathOf(request.url)}`;
  const fingerprint = sha256(`${method} ${request.url ?? ""}\n${JSON.stringify(request.body ?? null)}`);
  if (workspaceId !== null) return { ctx: tenant.ctx, slack: false, req: { scope: { kind: "workspace", workspaceId, actorId }, key, route, fingerprint } };
  if (orgId !== null) return { ctx: tenant.ctx, slack: false, req: { scope: { kind: "org", orgId, actorId }, key, route, fingerprint } };
  return null;
}

/**
 * Slack (ADR-046): the person is only resolved inside the handler, so the scope is the Slack team
 * the signed body names. The key is the request's `trigger_id` — Slack mints one per command, click
 * or form submission, and its retry (X-Slack-Retry-Num) carries the same one — or, for a body
 * without one, the signed timestamp and body (what a retry repeats and a new request never does).
 */
function slackPlan(request: IdempotentRequest, method: string): Plan | null {
  const rawBody = request.rawBody;
  if (rawBody === undefined) return null;
  const fields = slackFields(request.body);
  if (fields === null) return null;
  const route = `${method} ${pathOf(request.url)}`;
  const timestamp = request.headers["x-slack-request-timestamp"];
  const identity = fields.triggerId !== null ? `trigger:${fields.triggerId}` : `body:${String(timestamp)}:${rawBody}`;
  const hash = sha256(`${route}\n${identity}`);
  const ctx: TenantContext = { workspaceId: null, orgId: null, userId: null, isOrgAdmin: false, actorType: "system", requestId: request.id ?? `slack-${hash.slice(0, 12)}` };
  return { ctx, slack: true, req: { scope: { kind: "slack", teamId: fields.teamId }, key: `slack:${hash}`, route, fingerprint: hash } };
}

/** `team_id` / `trigger_id` of a slash command, or `payload.team.id` / `payload.trigger_id` of an interaction. */
function slackFields(body: unknown): { teamId: string; triggerId: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const fields = body as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const teamId = text(fields["team_id"]);
  if (teamId !== null) return { teamId, triggerId: text(fields["trigger_id"]) };
  if (typeof fields["payload"] !== "string") return null;
  try {
    const payload = JSON.parse(fields["payload"]) as { team?: { id?: unknown }; trigger_id?: unknown };
    const team = text(payload.team?.id);
    return team === null ? null : { teamId: team, triggerId: text(payload.trigger_id) };
  } catch {
    // Not JSON: the handler refuses it; there is nothing to key.
    return null;
  }
}

/** Only a JSON answer is stored for replay; a CSV, a string or a stream is not (the key is released instead). */
function replayable(body: unknown, reply: Reply): boolean {
  const type = reply.getHeader("content-type");
  if (typeof type === "string" && !type.toLowerCase().includes("json")) return false;
  if (typeof body === "string" || body instanceof Uint8Array) return false;
  if (typeof body === "object" && body !== null && typeof (body as { pipe?: unknown }).pipe === "function") return false;
  return true;
}
