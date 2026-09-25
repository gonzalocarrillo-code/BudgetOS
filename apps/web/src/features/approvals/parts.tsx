import { cn } from "@budget/ui";
import type { ReactElement } from "react";

export const stepLabel = (index: number) => `${index + 1}`;

const TONE: Record<string, string> = {
  PENDING: "bg-warning/15 text-foreground",
  ESCALATED: "bg-destructive/15 text-destructive",
  APPROVED: "bg-success/15 text-success",
  REJECTED: "bg-destructive/15 text-destructive",
  CHANGES_REQUESTED: "bg-warning/15 text-foreground",
  WITHDRAWN: "bg-muted text-muted-foreground",
};

/** A request status as a chip; the text is the status itself, never colour alone. */
export function StatusChip({ status }: { status: string }): ReactElement {
  return <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", TONE[status] ?? "bg-muted text-muted-foreground")} data-testid="status-chip">{status.toLowerCase().replace(/_/g, " ")}</span>;
}
