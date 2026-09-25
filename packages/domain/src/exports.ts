import { z } from "zod";
import { QueryRequest } from "./query.js";

/**
 * Exports (plan §6.2, spec §17 `exports`). A job runs the planner over every page of the query
 * (with the requester's read scope folded into the filter) and writes a file the caller downloads
 * through a short-lived URL. Sheets push is the GCP clause of T-023 and is not wired locally.
 */
export const ExportKind = z.enum(["csv", "xlsx", "sheets"]);
export type ExportKind = z.infer<typeof ExportKind>;
export const ExportStatus = z.enum(["queued", "running", "done", "failed"]);
export type ExportStatus = z.infer<typeof ExportStatus>;

/** A job never writes more rows than this (an XLSX sheet holds 1,048,576). */
export const EXPORT_MAX_ROWS = 500_000;

export const CreateExportInput = z.object({
  kind: ExportKind,
  /** The grid's query as it stands: filter, groupBy, measures, targets, period, sort. cursor and limit are ignored. */
  query: QueryRequest,
  /** Download name without extension; defaults to `budget-os-export-<date>`. */
  filename: z
    .string()
    .regex(/^[\w .-]{1,80}$/, "letters, digits, space, dot, dash or underscore; at most 80")
    .optional(),
});
export type CreateExportInput = z.infer<typeof CreateExportInput>;

/** Outbox payload of `export.requested`: the export worker runs this queued job. */
export const ExportRequested = z.object({ jobId: z.string().uuid() });
export type ExportRequested = z.infer<typeof ExportRequested>;

export const ExportJobView = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  kind: ExportKind,
  status: ExportStatus,
  filename: z.string(),
  rowCount: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  /** Present while `status` is `done`; expires after `expiresInSeconds`. */
  downloadUrl: z.string().nullable(),
  expiresInSeconds: z.number().int().nullable(),
});
export type ExportJobView = z.infer<typeof ExportJobView>;
