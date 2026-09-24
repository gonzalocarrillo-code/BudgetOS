import { DomainError } from "@budget/domain";
import type { z } from "zod";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Boundary validation in commands (the controller DTO pipe is the first line). */
export function parseInput<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DomainError("VALIDATION", "Invalid input", { issues: parsed.error.flatten() });
  return parsed.data;
}

export function parseId(raw: string): string {
  if (!UUID.test(raw)) throw new DomainError("VALIDATION", "Id must be a uuid");
  return raw;
}

export function requireWorkspace(workspaceId: string | null): string {
  if (workspaceId === null) throw new DomainError("VALIDATION", "Workspace required");
  return workspaceId;
}
