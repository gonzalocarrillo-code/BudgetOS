export type ErrorCode =
  | "UNAUTHENTICATED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "VALIDATION"
  | "CAP_EXCEEDED"
  | "LOCKED"
  | "POLICY_NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

export class DomainError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const httpStatus: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  VALIDATION: 422,
  CAP_EXCEEDED: 422,
  LOCKED: 423,
  POLICY_NOT_FOUND: 500,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};
