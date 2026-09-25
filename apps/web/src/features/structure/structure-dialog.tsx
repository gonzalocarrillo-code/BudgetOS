import { largestRemainder } from "@budget/domain";
import { formatMoney } from "@budget/grid";
import { Button, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Decimal } from "decimal.js";
import { ArrowRight, CheckCircle2, Clock, Plus, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { registryQuery, searchQuery, type EnvelopeDetail } from "../../lib/queries.js";

export type StructureOp = "add_child" | "move" | "split" | "merge";

const Cap = z.object({ id: z.string(), name: z.string(), approved: z.string().nullable(), childrenBefore: z.string(), childrenAfter: z.string(), remainingAfter: z.string().nullable(), overCap: z.boolean(), allowOverAllocation: z.boolean() });
const Preview = z.union([
  z.object({ ok: z.literal(true), op: z.string(), currency: z.string(), amount: z.string(), parent: Cap.nullable(), previousParent: Cap.nullable(), routing: z.object({ kind: z.enum(["immediate", "auto_approved", "approval"]), policy: z.object({ name: z.string(), version: z.number() }).nullable(), steps: z.array(z.string()) }) }),
  z.object({ ok: z.literal(false), op: z.string(), error: z.object({ code: z.string(), message: z.string(), details: z.unknown() }) }),
]);
type Preview = z.infer<typeof Preview>;
export interface StructureResult {
  op: StructureOp;
  requestId: string | null;
  autoApproved: boolean | null;
  newIds: string[];
}

/** The body, once the user stops typing for a moment: every preview is a real (rolled-back) transaction. */
function useSettled<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [key, ms]); // keyed by the value's JSON: a new object with the same content is not a change
  return settled;
}

const MONEY = /^\d{1,16}(\.\d{1,2})?$/;
const field = "h-9 w-full rounded-lg border border-input bg-card px-2 text-sm outline-none focus:border-ring";
const TITLES: Record<StructureOp, MessageKey> = { add_child: "structure.addChild", move: "structure.move", split: "structure.split", merge: "structure.merge" };

/**
 * Structure changes from the tree or the drawer (T-031b, plan 0.6 §9.3): add a child, move under
 * another parent, split into parts, merge siblings. The form feeds a live preview from the server
 * (the real command, rolled back): where it lands, the parent's cap before and after, and how it
 * is routed. Commit is one action; when the preview refuses, Commit says why.
 */
export function StructureDialog({ ws, op, env, onDone, onClose }: { ws: string; op: StructureOp; env: EnvelopeDetail; onDone: (r: StructureResult) => void; onClose: () => void }): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [rationale, setRationale] = useState("");
  // add child
  const [childName, setChildName] = useState("");
  const [childAmount, setChildAmount] = useState("");
  const [childDims, setChildDims] = useState<Record<string, string>>({});
  // move
  const [moveQ, setMoveQ] = useState("");
  const [moveTo, setMoveTo] = useState<{ id: string | null; name: string } | null>(null);
  // split
  const approved = env.current?.amount ?? "0.00";
  const evenly = (n: number) => largestRemainder(new Decimal(approved), Array.from({ length: n }, () => new Decimal(1))).map((a, i) => ({ name: `${env.name} · ${i + 1}`, amount: a.toFixed(2) }));
  const [parts, setParts] = useState(() => evenly(2));
  // merge
  const siblings = env.structure.siblings.filter((s) => s.currency === env.currency && s.approved !== null && s.status !== "PENDING");
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState("");

  useEffect(() => {
    // The first field, not the close button that comes before it.
    (dialogRef.current?.querySelector<HTMLElement>("input, select, textarea") ?? dialogRef.current?.querySelector<HTMLElement>("button"))?.focus();
  }, []);

  const { data: dims = [] } = useQuery(registryQuery(ws));
  const missingDims = dims.filter((d) => d.isActive && !(d.key in env.dimensionValues) && d.values.length > 0);
  const mergeSources = [env.id, ...mergeIds];
  const shared = (() => {
    const all = [env.dimensionValues, ...siblings.filter((s) => mergeIds.includes(s.id)).map((s) => s.dimensionValues)];
    return Object.fromEntries(Object.entries(env.dimensionValues).filter(([k, v]) => all.every((d) => d[k] === v)));
  })();

  const why = ((): string | null => {
    if (rationale.trim().length < 3) return t("structure.needReason");
    if (op === "add_child") return !childName.trim() ? t("structure.needName") : !MONEY.test(childAmount) ? t("structure.needAmount") : null;
    if (op === "move") return moveTo === null ? t("structure.needParent") : null;
    if (op === "split") return parts.some((p) => !p.name.trim() || !MONEY.test(p.amount)) ? t("structure.needParts") : null;
    return mergeIds.length === 0 ? t("structure.needSiblings") : !mergeName.trim() ? t("structure.needName") : null;
  })();
  const body = why
    ? null
    : op === "add_child"
      ? { op, envelopeId: env.id, input: { name: childName.trim(), amount: childAmount, dimensionValues: childDims, rationale: rationale.trim() } }
      : op === "move"
        ? { op, envelopeId: env.id, input: { parentId: moveTo?.id ?? null, rowVersion: env.rowVersion, rationale: rationale.trim() } }
        : op === "split"
          ? { op, envelopeId: env.id, input: { basedOnVersionId: env.draftVersionId ?? env.currentVersionId, rationale: rationale.trim(), parts: parts.map((p) => ({ name: p.name.trim(), amount: p.amount })) } }
          : { op, input: { sourceIds: mergeSources, name: mergeName.trim(), dimensionValues: shared, rationale: rationale.trim() } };
  const settled = useSettled(body);
  const pending = JSON.stringify(settled) !== JSON.stringify(body);
  const preview = useQuery({
    queryKey: ["structure-preview", ws, settled],
    queryFn: async () => Preview.parse(await unwrap(api.POST("/api/v1/envelopes/structure/preview", { params: { header: { "X-Workspace-Id": ws } }, body: settled as never }))),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 0,
  });

  const commit = useMutation({
    mutationFn: async (): Promise<StructureResult> => {
      const header = { "X-Workspace-Id": ws };
      if (!body) throw new Error(why ?? "");
      const pick = (r: unknown) => r as { requestId?: string | null; autoApproved?: boolean; envelopeId?: string; partIds?: string[]; targetId?: string };
      if (body.op === "add_child") {
        const r = pick(await unwrap(api.POST("/api/v1/envelopes/{id}/children", { params: { path: { id: env.id }, header }, body: body.input as never })));
        return { op, requestId: r.requestId ?? null, autoApproved: r.autoApproved ?? null, newIds: r.envelopeId ? [r.envelopeId] : [] };
      }
      if (body.op === "move") {
        await unwrap(api.POST("/api/v1/envelopes/{id}/move", { params: { path: { id: env.id }, header }, body: body.input as never }));
        return { op, requestId: null, autoApproved: null, newIds: [] };
      }
      if (body.op === "split") {
        const r = pick(await unwrap(api.POST("/api/v1/envelopes/{id}/split", { params: { path: { id: env.id }, header }, body: body.input as never })));
        return { op, requestId: r.requestId ?? null, autoApproved: r.autoApproved ?? null, newIds: r.partIds ?? [] };
      }
      const r = pick(await unwrap(api.POST("/api/v1/envelopes/merge", { params: { header }, body: body.input as never })));
      return { op, requestId: r.requestId ?? null, autoApproved: r.autoApproved ?? null, newIds: r.targetId ? [r.targetId] : [] };
    },
    onSuccess: onDone,
  });

  const p = preview.data;
  const commitWhy = why ?? (pending || preview.isFetching ? t("structure.checking") : !p ? t("structure.checking") : !p.ok ? p.error.message : commit.isPending ? t("shell.loading") : null);
  const commitLabel = p?.ok && p.routing.kind === "approval" ? t("structure.submit") : p?.ok && p.routing.kind === "immediate" ? t("structure.moveNow") : t("structure.apply");

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-inverse/30 p-6" role="dialog" aria-modal="true" aria-labelledby="structure-title" onKeyDown={(e) => e.key === "Escape" && onClose()} data-testid="structure-dialog" data-op={op}>
      <div ref={dialogRef} className="flex max-h-[88vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 id="structure-title" className="text-lg font-semibold tracking-[-0.015em]">
              {t(TITLES[op])}
            </h2>
            <p className="text-sm text-muted-foreground">{t(`structure.${op}.help` as MessageKey, { name: env.name })}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("drawer.close")}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>

        {op === "add_child" ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <Labeled label={t("structure.childName")}>
              <input className={field} value={childName} onChange={(e) => setChildName(e.target.value)} placeholder={`${env.name} · …`} data-testid="child-name" />
            </Labeled>
            <Labeled label={t("structure.amount", { currency: env.currency })}>
              <input className={cn(field, "text-right tabular")} inputMode="decimal" value={childAmount} onChange={(e) => setChildAmount(e.target.value)} placeholder="0.00" data-testid="child-amount" />
            </Labeled>
            <div className="sm:col-span-2">
              <p className="mb-1 text-sm font-medium">{t("structure.dimensions")}</p>
              <p className="mb-2 text-xs text-muted-foreground">{t("structure.inherits", { values: Object.values(env.dimensionValues).join(" · ") || "—" })}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {missingDims.map((d) => (
                  <label key={d.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {d.label}
                    <select className={field} value={childDims[d.key] ?? ""} onChange={(e) => setChildDims((c) => (e.target.value ? { ...c, [d.key]: e.target.value } : Object.fromEntries(Object.entries(c).filter(([k]) => k !== d.key))))} data-testid="child-dim" data-key={d.key}>
                      <option value="">{t("structure.dimNone")}</option>
                      {d.values
                        .filter((v) => v.isActive)
                        .map((v) => (
                          <option key={v.code} value={v.code}>
                            {v.label}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {op === "move" ? <MovePicker ws={ws} env={env} q={moveQ} setQ={setMoveQ} value={moveTo} onPick={setMoveTo} /> : null}

        {op === "split" ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{t("structure.splitApproved", { amount: formatMoney(approved, env.currency) })}</p>
            {parts.map((part, i) => (
              <div key={i} className="flex gap-2" data-testid="split-part">
                <input className={field} value={part.name} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={t("structure.partName", { n: i + 1 })} data-testid="split-name" />
                <input className={cn(field, "w-36 text-right tabular")} inputMode="decimal" value={part.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label={t("structure.partAmount", { n: i + 1 })} data-testid="split-amount" />
                {parts.length > 2 ? (
                  <Button variant="ghost" size="icon" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label={t("structure.removePart", { n: i + 1 })}>
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            ))}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setParts([...parts, { name: `${env.name} · ${parts.length + 1}`, amount: "0.00" }])} data-testid="split-add">
                <Plus className="size-4" aria-hidden />
                {t("structure.addPart")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setParts(evenly(parts.length).map((x, i) => ({ ...x, name: parts[i]?.name ?? x.name })))} data-testid="split-even">
                {t("structure.evenly")}
              </Button>
            </div>
          </div>
        ) : null}

        {op === "merge" ? (
          <div className="flex flex-col gap-3">
            {siblings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("structure.noSiblings")}</p>
            ) : (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-sm font-medium">{t("structure.mergeWith", { name: env.name })}</legend>
                {siblings.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
                    <input type="checkbox" checked={mergeIds.includes(s.id)} onChange={(e) => setMergeIds(e.target.checked ? [...mergeIds, s.id] : mergeIds.filter((x) => x !== s.id))} data-testid="merge-sibling" data-name={s.name} />
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="tabular text-muted-foreground">{s.approved ? formatMoney(s.approved, s.currency) : "—"}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <Labeled label={t("structure.mergedName")}>
              <input className={field} value={mergeName} onChange={(e) => setMergeName(e.target.value)} data-testid="merge-name" />
            </Labeled>
            {mergeIds.length ? <p className="text-xs text-muted-foreground">{t("structure.mergedDims", { values: Object.values(shared).join(" · ") || "—" })}</p> : null}
          </div>
        ) : null}

        <Labeled label={t("structure.reason")}>
          <input className={field} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder={t("structure.reasonHint")} data-testid="structure-reason" />
        </Labeled>

        <PreviewPanel preview={p} stale={pending || preview.isFetching} waiting={why} />
        {commit.error ? <p role="alert" className="text-sm text-destructive">{commit.error.message}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("threads.cancel")}
          </Button>
          {commitWhy ? (
            <Button disabled reason={commitWhy} data-testid="structure-commit">
              {commitLabel}
            </Button>
          ) : (
            <Button onClick={() => commit.mutate()} data-testid="structure-commit">
              {commitLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

function MovePicker({ ws, env, q, setQ, value, onPick }: { ws: string; env: EnvelopeDetail; q: string; setQ: (q: string) => void; value: { id: string | null; name: string } | null; onPick: (v: { id: string | null; name: string }) => void }): ReactElement {
  const settled = useSettled(q.trim(), 250);
  const { data } = useQuery({ ...searchQuery(ws, settled, { types: "envelope", limit: 8 }), enabled: settled.length > 1 });
  const hits = (data?.groups.find((g) => g.type === "envelope")?.hits ?? []).filter((h) => h.id !== env.id && h.id !== env.parentId);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        {t("structure.currentParent")} <span className="font-medium">{env.structure.parent?.name ?? t("structure.topLevel")}</span>
      </p>
      <Labeled label={t("structure.newParent")}>
        <input type="search" className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("structure.searchParent")} data-testid="move-search" />
      </Labeled>
      <ul className="flex flex-col gap-1" aria-label={t("structure.newParent")} data-testid="move-options">
        {env.parentId !== null ? (
          <li>
            <PickButton selected={value?.id === null} onClick={() => onPick({ id: null, name: t("structure.topLevel") })} testId="move-top">
              {t("structure.topLevel")}
            </PickButton>
          </li>
        ) : null}
        {hits.map((h) => (
          <li key={h.id}>
            <PickButton selected={value?.id === h.id} onClick={() => onPick({ id: h.id, name: h.title })} testId="move-option">
              <span className="font-medium">{h.title}</span>
              {h.path ? <span className="ml-2 text-xs text-muted-foreground">{h.path}</span> : null}
            </PickButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PickButton({ selected, onClick, testId, children }: { selected: boolean; onClick: () => void; testId: string; children: ReactNode }): ReactElement {
  return (
    <button type="button" aria-pressed={selected} className={cn("w-full rounded-lg border px-3 py-1.5 text-left text-sm", selected ? "border-primary bg-secondary" : "border-border hover:bg-accent")} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  );
}

/** What the server said the change would do (or why it would not). */
function PreviewPanel({ preview: p, stale, waiting }: { preview: Preview | undefined; stale: boolean; waiting: string | null }): ReactElement {
  if (waiting) return <p className="rounded-lg bg-surface px-3 py-2 text-sm text-muted-foreground" data-testid="structure-preview">{t("structure.previewWaiting")}</p>;
  if (!p) return <p className="rounded-lg bg-surface px-3 py-2 text-sm text-muted-foreground" data-testid="structure-preview">{t("structure.checking")}</p>;
  if (!p.ok) {
    return (
      <div role="alert" className={cn("flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm", stale ? "opacity-60" : "")} data-testid="structure-preview" data-ok="false">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <span>
          <span className="font-medium">{t("structure.refused")}</span> {p.error.message}
        </span>
      </div>
    );
  }
  const money = (v: string | null) => (v === null ? "—" : formatMoney(v, p.currency));
  const cap = (c: z.infer<typeof Cap>, label: string) => (
    <li className="flex flex-col gap-0.5" data-testid="preview-cap">
      <span className="font-medium">{label}</span>
      <span className="tabular text-muted-foreground">
        {t("structure.capLine", { approved: money(c.approved), before: money(c.childrenBefore), after: money(c.childrenAfter) })}
        {c.remainingAfter !== null ? ` · ${t("structure.remaining", { amount: money(c.remainingAfter) })}` : ""}
      </span>
      {c.overCap ? <span className="text-destructive">{t("structure.overCap")}</span> : null}
    </li>
  );
  const routing = p.routing;
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm", stale ? "opacity-60" : "")} data-testid="structure-preview" data-ok="true" aria-live="polite">
      <p className="tabular">{t("structure.previewAmount", { amount: money(p.amount) })}</p>
      <ul className="flex flex-col gap-1.5">
        {p.parent ? cap(p.parent, t("structure.capOf", { name: p.parent.name })) : null}
        {p.previousParent ? cap(p.previousParent, t("structure.capFrom", { name: p.previousParent.name })) : null}
      </ul>
      <p className="flex items-center gap-1.5" data-testid="preview-routing" data-kind={routing.kind}>
        {routing.kind === "approval" ? <Clock className="size-4 text-warning" aria-hidden /> : <CheckCircle2 className="size-4 text-success" aria-hidden />}
        {routing.kind === "immediate" ? t("structure.routeImmediate") : routing.kind === "auto_approved" ? t("structure.routeAuto", { policy: routing.policy?.name ?? "—" }) : t("structure.routeApproval", { policy: routing.policy?.name ?? "—" })}
        {routing.steps.length ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            {routing.steps.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1">
                {i > 0 ? <ArrowRight className="size-3" aria-hidden /> : null}
                {s.toLowerCase().replace(/_/g, " ")}
              </span>
            ))}
          </span>
        ) : null}
      </p>
    </div>
  );
}
