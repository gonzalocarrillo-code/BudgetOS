import { ChainStep, PolicyConditions, type PolicyConditions as Conditions } from "@budget/domain";
import { Button, cn, EmptyState, Input, Select, Modal } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, Plus, UserCheck, ShieldCheck } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Approval policies (spec §9, plan §8.1; product feedback 6). The first active policy, top to
 * bottom, that matches a change decides who approves it; one with no steps sets the change at
 * once. "Who is asking" lets some people (by role) set budgets without approval.
 */
export const Route = createFileRoute("/w/$ws/admin/policies")({ component: PoliciesPage });

const Policy = z
  .object({ id: z.string().uuid(), name: z.string(), priority: z.number(), version: z.number(), isActive: z.boolean(), conditions: z.unknown(), chain: z.unknown(), blockSelfApproval: z.boolean(), allowExternalEvidence: z.boolean() })
  .passthrough()
  .transform((p) => ({ ...p, conditions: PolicyConditions.safeParse(p.conditions).data ?? ({} as Conditions), chain: z.array(ChainStep).safeParse(p.chain).data ?? [] }));
type Policy = z.infer<typeof Policy>;

const policiesQuery = (ws: string) => ({
  queryKey: ["policies", ws],
  queryFn: async () => z.array(Policy).parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/policies", { params: { path: { ws } } }))),
});

// The roles that can send a change (envelope.edit_draft / envelope.submit).
const REQUESTER_ROLES = ["PLANNER", "BUDGET_OWNER", "WORKSPACE_ADMIN"] as const;
const STEP_ROLES = ["BUDGET_OWNER", "APPROVER", "FINANCE", "WORKSPACE_ADMIN"] as const;
const ENTITIES = ["envelope_version", "bulk_change", "target_version", "manual_entry"] as const;
const roleLabel = (r: string) => t(`role.${r.toLowerCase()}` as MessageKey);

/** Plain-language "when" of a policy. */
function describe(c: Conditions): string[] {
  const out: string[] = [];
  if (c.entityType) out.push(t(`policy.entity.${c.entityType}` as MessageKey));
  if (c.requester?.roles?.length) out.push(t("policy.when.requester", { roles: c.requester.roles.map(roleLabel).join(", ") }));
  if (c.requester?.userIds?.length) out.push(t("policy.when.people", { count: c.requester.userIds.length }));
  const range = (r: { gte?: number | undefined; lt?: number | undefined } | undefined, key: "amount" | "delta") => {
    if (!r) return;
    const f = (n: number) => (key === "delta" ? `${Math.round(n * 1000) / 10} %` : n.toLocaleString());
    if (r.gte !== undefined && r.lt !== undefined) out.push(t(`policy.when.${key}Between` as MessageKey, { min: f(r.gte), max: f(r.lt) }));
    else if (r.gte !== undefined) out.push(t(`policy.when.${key}AtLeast` as MessageKey, { min: f(r.gte) }));
    else if (r.lt !== undefined) out.push(t(`policy.when.${key}Under` as MessageKey, { max: f(r.lt) }));
  };
  range(c.amountAbs, "amount");
  range(c.deltaPct, "delta");
  if (c.isOverAllocation) out.push(t("policy.when.over"));
  if (c.dimension) for (const [k, v] of Object.entries(c.dimension)) out.push(`${k}: ${v.join(", ")}`);
  if (c.any?.length) out.push(t("policy.when.any", { count: c.any.length }));
  return out.length ? out : [t("policy.when.always")];
}

function PoliciesPage(): ReactElement {
  const { ws } = Route.useParams();
  const { data: policies = [], error } = useQuery(policiesQuery(ws));
  const { data: me } = useQuery(meQuery);
  const canManage = me?.isOrgAdmin || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("policy.manage") ?? false);
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  return (
    <Page title={t("admin.policies")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-2xl flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t("policy.intro")}</p>
          <p className="text-sm text-muted-foreground" data-testid="policy-admins-direct">{t("policy.adminsDirect")}</p>
        </div>
        {canManage ? (
          <Button onClick={() => setEditing("new")} data-testid="policy-new">
            <Plus className="size-4" aria-hidden /> {t("policy.new")}
          </Button>
        ) : (
          <Button disabled reason={t("policy.noPermission")}>
            <Plus className="size-4" aria-hidden /> {t("policy.new")}
          </Button>
        )}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {policies.length === 0 ? (
        <Card>
          <EmptyState icon={ShieldCheck} title={t("policies.empty.title")} body={t("policies.empty.body")} action={canManage ? <Button size="sm" onClick={() => setEditing("new")}>{t("policy.new")}</Button> : undefined} />
        </Card>
      ) : null}
      <ol className="flex flex-col gap-3" data-testid="policy-list">
        {policies.map((p, i) => (
          <li key={p.id}>
            <Card>
              <div className={cn("flex flex-wrap items-start gap-4", !p.isActive && "opacity-60")} data-testid="policy" data-name={p.name}>
                <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold tabular-nums">{i + 1}</span>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{p.name}</h3>
                    {!p.isActive ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("policy.off")}</span> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{t("policy.when")}</span>
                    {describe(p.conditions).map((d) => (
                      <span key={d} className="rounded-md border border-border px-2 py-0.5">{d}</span>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="policy-then">
                    <span className="text-muted-foreground">{t("policy.then")}</span>
                    {p.chain.length === 0 ? (
                      <span className="inline-flex items-center gap-1.5 font-medium text-success"><CircleCheck className="size-4" aria-hidden />{t("policy.direct")}</span>
                    ) : (
                      p.chain.map((s, j) => (
                        <span key={j} className="inline-flex items-center gap-1.5">
                          {j > 0 ? <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden /> : null}
                          <span className="rounded-md bg-secondary px-2 py-0.5">{roleLabel(s.role)}{s.minApprovals > 1 ? ` ×${s.minApprovals}` : ""}</span>
                        </span>
                      ))
                    )}
                  </div>
                </div>
                {canManage ? (
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)} data-testid="policy-edit">
                    {t("policy.edit")}
                  </Button>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ol>
      {editing ? <PolicyEditor ws={ws} policy={editing === "new" ? null : editing} nextPriority={Math.max(0, Math.min(...policies.map((p) => p.priority), 1) - 1)} onClose={() => setEditing(null)} /> : null}
    </Page>
  );
}

function PolicyEditor({ ws, policy, nextPriority, onClose }: { ws: string; policy: Policy | null; nextPriority: number; onClose: () => void }): ReactElement {
  const client = useQueryClient();
  const c = policy?.conditions ?? {};
  const [name, setName] = useState(policy?.name ?? "");
  const [priority, setPriority] = useState(String(policy?.priority ?? nextPriority));
  const [entity, setEntity] = useState<string>(c.entityType ?? "");
  const [roles, setRoles] = useState<string[]>(c.requester?.roles ?? []);
  const [amountMin, setAmountMin] = useState(c.amountAbs?.gte?.toString() ?? "");
  const [amountMax, setAmountMax] = useState(c.amountAbs?.lt?.toString() ?? "");
  const [direct, setDirect] = useState(policy ? policy.chain.length === 0 : false);
  const [steps, setSteps] = useState<ChainStep[]>(policy?.chain.length ? policy.chain : [{ role: "APPROVER", minApprovals: 1, timeoutHours: 48 }]);
  const [active, setActive] = useState(policy?.isActive ?? true);

  const conditions = (): Conditions => {
    // Fields this form does not edit (dimensions, any, …) are kept as they are.
    const next: Conditions = { ...c };
    delete next.entityType;
    delete next.requester;
    delete next.amountAbs;
    if (entity) next.entityType = entity as Conditions["entityType"];
    if (roles.length) next.requester = { ...(c.requester?.userIds ? { userIds: c.requester.userIds } : {}), roles };
    else if (c.requester?.userIds) next.requester = { userIds: c.requester.userIds };
    const min = amountMin.trim() === "" ? undefined : Number(amountMin);
    const max = amountMax.trim() === "" ? undefined : Number(amountMax);
    if (min !== undefined || max !== undefined) next.amountAbs = { ...(min !== undefined ? { gte: min } : {}), ...(max !== undefined ? { lt: max } : {}) };
    return next;
  };
  const invalid = name.trim() === "" ? t("policy.needName") : !/^\d+$/.test(priority) ? t("policy.needPriority") : [amountMin, amountMax].some((v) => v.trim() !== "" && !Number.isFinite(Number(v))) ? t("policy.needNumber") : null;

  const save = useMutation({
    meta: { success: t("toast.policySaved") },
    mutationFn: async () => {
      const body = { name: name.trim(), priority: Number(priority), conditions: conditions(), chain: direct ? [] : steps };
      if (policy) return unwrap(api.PATCH("/api/v1/policies/{id}", { params: { path: { id: policy.id }, header: { "X-Workspace-Id": ws } }, body: { ...body, version: policy.version, isActive: active } as never }));
      return unwrap(api.POST("/api/v1/workspaces/{ws}/policies", { params: { path: { ws } }, body: body as never }));
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["policies", ws] });
      onClose();
    },
  });

  const field = "";
  const setStep = (i: number, patch: Partial<ChainStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal onClose={onClose} labelledBy="policy-title" testId="policy-editor">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col gap-5 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
        <h2 id="policy-title" className="text-lg font-semibold tracking-[-0.015em]">{policy ? t("policy.editTitle", { name: policy.name }) : t("policy.new")}</h2>
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("policy.name")}</span>
            <Input className={field} value={name} onChange={(e) => setName(e.target.value)} data-testid="policy-name" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("policy.priority")}</span>
            <Input className={cn(field, "text-right tabular-nums")} value={priority} onChange={(e) => setPriority(e.target.value)} inputMode="numeric" data-testid="policy-priority" />
          </label>
          <p className="col-span-2 -mt-1 text-xs text-muted-foreground">{t("policy.priorityHelp")}</p>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("policy.when")}</legend>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t("policy.what")}</span>
            <Select className={field} value={entity} onChange={(e) => setEntity(e.target.value)} data-testid="policy-entity">
              <option value="">{t("policy.entity.any")}</option>
              {ENTITIES.map((x) => (
                <option key={x} value={x}>{t(`policy.entity.${x}` as MessageKey)}</option>
              ))}
            </Select>
          </label>
          <div className="flex flex-col gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5"><UserCheck className="size-4 text-muted-foreground" aria-hidden />{t("policy.who")}</span>
            <div className="flex flex-wrap gap-2" data-testid="policy-roles">
              {REQUESTER_ROLES.map((r) => (
                <label key={r} className={cn("inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm", roles.includes(r) ? "border-primary bg-secondary" : "border-border")}>
                  <input type="checkbox" className="accent-[var(--color-primary)]" checked={roles.includes(r)} onChange={(e) => setRoles((rs) => (e.target.checked ? [...rs, r] : rs.filter((x) => x !== r)))} data-testid={`policy-role-${r}`} />
                  {roleLabel(r)}
                </label>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">{roles.length ? t("policy.whoSome") : t("policy.whoAnyone")}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t("policy.amount")}</span>
            <Input className={cn(field, "w-32 text-right tabular-nums")} placeholder={t("policy.min")} value={amountMin} onChange={(e) => setAmountMin(e.target.value)} inputMode="decimal" />
            <span className="text-muted-foreground">–</span>
            <Input className={cn(field, "w-32 text-right tabular-nums")} placeholder={t("policy.max")} value={amountMax} onChange={(e) => setAmountMax(e.target.value)} inputMode="decimal" />
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{t("policy.then")}</legend>
          <div role="radiogroup" className="inline-flex w-fit rounded-md border border-border p-0.5">
            {([true, false] as const).map((d) => (
              <button key={String(d)} type="button" role="radio" aria-checked={direct === d} onClick={() => setDirect(d)} className={cn("h-7 rounded px-3 text-sm", direct === d ? "bg-primary text-primary-foreground" : "text-foreground/80 hover:bg-accent")} data-testid={d ? "policy-direct" : "policy-steps"}>
                {d ? t("policy.direct") : t("policy.needsApproval")}
              </button>
            ))}
          </div>
          {direct ? (
            <p className="text-sm text-muted-foreground">{t("policy.directHelp")}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {steps.map((s, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-14 text-muted-foreground">{t("policy.step", { n: i + 1 })}</span>
                  <Select className={field} value={s.role} onChange={(e) => setStep(i, { role: e.target.value as ChainStep["role"] })}>
                    {STEP_ROLES.map((r) => (
                      <option key={r} value={r}>{roleLabel(r)}</option>
                    ))}
                  </Select>
                  <Input className={cn(field, "w-14 text-right")} value={s.minApprovals} onChange={(e) => setStep(i, { minApprovals: Math.max(1, Number(e.target.value) || 1) })} aria-label={t("policy.minApprovals")} />
                  <span className="text-muted-foreground">{t("policy.approvals")}</span>
                  {steps.length > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))}>{t("policy.removeStep")}</Button>
                  ) : null}
                </li>
              ))}
              {steps.length < 10 ? (
                <li>
                  <Button size="sm" variant="ghost" onClick={() => setSteps((x) => [...x, { role: "FINANCE", minApprovals: 1, timeoutHours: 48 }])}>
                    <Plus className="size-3.5" aria-hidden /> {t("policy.addStep")}
                  </Button>
                </li>
              ) : null}
            </ol>
          )}
        </fieldset>
        {policy ? (
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-[var(--color-primary)]" checked={active} onChange={(e) => setActive(e.target.checked)} data-testid="policy-active" />
            {t("policy.active")}
          </label>
        ) : null}
        {save.error ? <p role="alert" className="text-sm text-destructive">{save.error.message}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("paste.cancel")}</Button>
          {invalid || save.isPending ? (
            <Button disabled reason={invalid ?? t("shell.loading")}>{t("policy.save")}</Button>
          ) : (
            <Button onClick={() => save.mutate()} data-testid="policy-save">{t("policy.save")}</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
