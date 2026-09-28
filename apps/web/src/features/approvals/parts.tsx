import { StatusChip as SharedStatusChip } from "@budget/ui";
import type { ReactElement } from "react";

export const stepLabel = (index: number) => `${index + 1}`;

/** A request status as a chip: the shared vocabulary (UX-006), a word and an icon, never colour alone. */
export function StatusChip({ status }: { status: string }): ReactElement {
  return <SharedStatusChip status={status} data-testid="status-chip" />;
}
