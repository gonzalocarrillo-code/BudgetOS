import { Prisma } from "@prisma/client";
import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import type { TenantRequest } from "./tenant.js";

/**
 * W5-1 (audit M-3, I-15): everything DomainExceptionFilter doesn't recognise lands here — a Prisma
 * error (unique/transaction-timeout/deadlock), a NestJS `HttpException` (including the
 * `NotFoundException` Nest itself throws for an unmatched route — without this filter's own
 * `HttpException` branch that would otherwise become a generic 500 instead of its real 404), or any
 * other unexpected throw. Registered as the `APP_FILTER` *before* DomainExceptionFilter in
 * common.module.ts: Nest tries global filters most-recently-provided first, so the filter declared
 * last there (DomainExceptionFilter) is checked first, and a `DomainError` still goes to its own
 * specific mapping — this one is the fallback `@Catch()` with no argument, so it only ever sees
 * what DomainExceptionFilter declined.
 *
 * The response body keeps DomainExceptionFilter's `{ code, message, details }` shape plus
 * `requestId`. A Prisma/driver error's real message never reaches the client (it can carry table
 * and column names) — only a fixed, generic message per bucket; an `HttpException`'s own message
 * does, same as it always did before this filter existed.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const httpCtx = host.switchToHttp();
    const request = httpCtx.getRequest<TenantRequest>();
    const response = httpCtx.getResponse<{ status: (code: number) => { send: (body: unknown) => void } }>();
    const requestId = request.id;
    const { status, code, message } = classify(error);

    this.logger.error(
      { err: error, requestId, workspaceId: request.tenant?.ctx.workspaceId ?? null, actorId: request.tenant?.ctx.userId ?? null, code },
      `unhandled error mapped to ${code}`,
    );

    response.status(status).send({ code, message, details: null, requestId });
  }
}

interface Classified {
  status: number;
  code: string;
  message: string;
}

/** Postgres error codes (surfaced by Prisma as `P2010`'s `meta.code` on a raw-query failure) this filter recognises. */
const PG_CODE: Record<string, Classified> = {
  // Deadlock detected (I-15: moveIn/decide lock-order inversion).
  "40P01": { status: 409, code: "CONFLICT", message: "This change conflicted with another in-flight change; retry it" },
  // unique_violation, raised outside Prisma's own tracked-constraint path (e.g. inside a raw statement).
  "23505": { status: 409, code: "CONFLICT", message: "This change conflicts with an existing record" },
};

/** Nest's own default statuses (BadRequestException, NotFoundException, ForbiddenException, …). */
const HTTP_STATUS_CODE: Record<number, string> = {
  400: "VALIDATION",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION",
  423: "LOCKED",
  429: "RATE_LIMITED",
  503: "UNAVAILABLE",
};

function classify(error: unknown): Classified {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const body = error.getResponse();
    const rawMessage = typeof body === "string" ? body : ((body as { message?: unknown } | null)?.message ?? error.message);
    const message = Array.isArray(rawMessage) ? rawMessage.join("; ") : String(rawMessage);
    return { status, code: HTTP_STATUS_CODE[status] ?? (status >= 500 ? "INTERNAL" : "VALIDATION"), message };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002": // Unique constraint failed.
      case "P2034": // Transaction failed due to a write conflict or a deadlock; retries exhausted.
        return { status: 409, code: "CONFLICT", message: "This change conflicts with an existing record" };
      case "P2025": // An operation depended on a record that was not found.
        return { status: 404, code: "NOT_FOUND", message: "Not found" };
      case "P2028": // Transaction API error (includes the transaction timeout, audit I-7).
        return { status: 503, code: "UNAVAILABLE", message: "The database is busy; retry" };
      case "P2010": { // Raw query failed: the real reason is the wrapped Postgres error code.
        const pgCode = (error.meta as { code?: unknown } | null)?.code;
        const mapped = typeof pgCode === "string" ? PG_CODE[pgCode] : undefined;
        if (mapped) return mapped;
        break;
      }
      default:
        break;
    }
  }
  return { status: 500, code: "INTERNAL", message: "Internal error" };
}
