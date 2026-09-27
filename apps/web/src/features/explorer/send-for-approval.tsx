import { formatMoney } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleCheck, Clock, Send } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { envelopeQuery } from "../../lib/queries.js";

/**
 * Where a budget change goes next (product feedback 3: "no idea where send for approval lives").
 * A draft shows what it changes and a Send for approval button; a sent draft shows who has it and
 * lets you withdraw it; right after sending, what happened (approved by policy, or waiting).
 * Used at the top of the drawer and in the notice after an inline edit.
 */

const Submitted = z.object({ autoApproved: z.boolean(), requestId: z.string().uuid().nullable(), policy: z.object({ name: z.string() }).passthrough() }).passthrough();
type Submitted = z.infer<typeof Submitted>;

export function SendForApproval({ ws, envelopeId, compact = false }: { ws: string; envelopeId: string; compact?: boolean }): ReactElement | null {
  const client = useQueryClient();
  const { data: env } = useQuery(envelopeQuery(ws, envelopeId));
  const [sent, setSent] = useState<Submitted | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["envelope", ws, envelopeId] });
    await client.invalidateQueries({ queryKey: ["approvals"] });
  };
  const submit = useMutation({
    mutationFn: async (versionId: string) => Submitted.parse(await unwrap(api.POST("/api/v1/envelopes/{id}/submit", { params: { path: { id: envelopeId }, header: { "X-Workspace-Id": ws } }, body: { versionId } as never }))),
    onSuccess: async (r) => {
      setSent(r);
      setWithdrawn(false);
      await refresh();
    },
  });
  const withdraw = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/envelopes/{id}/withdraw", { params: { path: { id: envelopeId }, header: { "X-Workspace-Id": ws } }, body: {} as never })),
    onSuccess: async () => {
      setSent(null);
      setWithdrawn(true);
      await refresh();
    },
  });

  const box = cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-sm", compact ? "" : "rounded-lg border px-3 py-2.5");
  if (sent?.autoApproved) {
    return (
      <div className={cn(box, !compact && "border-success/40 bg-success/10")} data-testid="approval-state" data-state="approved">
        <CircleCheck className="size-4 text-success" aria-hidden />
        <span className="flex-1">{t("approval.send.approved", { policy: sent.policy.name })}</span>
      </div>
    );
  }
  if (!env?.draft) {
    // A withdrawn version is kept; the budget is back to its approved amount (no draft left).
    if (!withdrawn) return null;
    return (
      <div className={cn(box, !compact && "border-border bg-muted/40")} data-testid="approval-state" data-state="withdrawn">
        <span className="flex-1 text-muted-foreground">{t("approval.send.withdrawn", { approved: env?.current ? formatMoney(env.current.amount, env.currency) : "—" })}</span>
      </div>
    );
  }
  const request = env.openRequest ?? (sent?.requestId ? { id: sent.requestId, status: "PENDING", summary: "" } : null);
  if (request) {
    return (
      <div className={cn(box, !compact && "border-warning/40 bg-warning/10")} data-testid="approval-state" data-state="waiting">
        <Clock className="size-4 text-warning" aria-hidden />
        <span className="flex-1">{t("approval.send.waiting", { amount: formatMoney(env.draft.amount, env.currency) })}</span>
        <Link to="/w/$ws/approvals/$id" params={{ ws, id: request.id }} className="font-medium text-primary hover:underline" data-testid="approval-open-request">
          {t("structure.openRequest")}
        </Link>
        <Button size="sm" variant="ghost" onClick={() => withdraw.mutate()} {...(withdraw.isPending ? { disabled: true as const, reason: t("approval.send.working") } : {})} data-testid="approval-withdraw">
          {t("approval.send.withdraw")}
        </Button>
      </div>
    );
  }
  const draft = env.draft;
  return (
    <div className={cn(box, !compact && "border-primary/30 bg-secondary")} data-testid="approval-state" data-state="draft">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{t("approval.send.draft", { amount: formatMoney(draft.amount, env.currency), approved: env.current ? formatMoney(env.current.amount, env.currency) : "—" })}</span>
        {env.draftPolicy ? (
          <span className="text-xs text-muted-foreground" data-testid="approval-policy">
            {env.draftPolicy.autoApprove ? t("approval.send.policyDirect", { policy: env.draftPolicy.name }) : t("approval.send.policyRoute", { policy: env.draftPolicy.name, role: t(`role.${(env.draftPolicy.firstRole ?? "APPROVER").toLowerCase()}` as "role.approver"), steps: env.draftPolicy.steps })}
          </span>
        ) : null}
      </span>
      <Button size="sm" onClick={() => submit.mutate(draft.id)} {...(submit.isPending ? { disabled: true as const, reason: t("approval.send.working") } : {})} data-testid="approval-send" data-direct={env.draftPolicy?.autoApprove ? "true" : "false"}>
        <Send className="size-3.5" aria-hidden />
        {env.draftPolicy?.autoApprove ? t("approval.send.apply") : t("approval.send.button")}
      </Button>
      {submit.error ? (
        <p role="alert" className="w-full text-xs text-destructive" data-testid="approval-send-error">
          {submit.error.message}
        </p>
      ) : null}
    </div>
  );
}
