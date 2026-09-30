import { OrgWorkspacesResponse, type OrgWorkspace } from "@budget/domain";
import { Button, EmptyState, SkeletonRows, StatusChip, cn, toast, Input, Select } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Building2, Plus, Trash2, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";

/**
 * Org console › Workspaces (ADR-052): every workspace of the organization. A superadmin creates one
 * from a template with its first admin, archives it (read-only, hidden from its members), restores
 * it, and deletes an archived one by typing its name.
 */
export const Route = createFileRoute("/org/workspaces")({ component: WorkspacesPage });

const workspacesQuery = { queryKey: ["org-workspaces"], queryFn: async () => OrgWorkspacesResponse.parse(await unwrap(api.GET("/api/v1/workspaces", {}))) };
const field = "w-full";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");

function WorkspacesPage(): ReactElement {
  const client = useQueryClient();
  const { data, isPending, error } = useQuery(workspacesQuery);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<OrgWorkspace | null>(null);
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["org-workspaces"] }), client.invalidateQueries({ queryKey: ["me"] })]);
  const status = useMutation({
    meta: { error: true },
    mutationFn: async (v: { ws: string; status: "ACTIVE" | "ARCHIVED" }) => unwrap(api.PATCH("/api/v1/workspaces/{ws}", { params: { path: { ws: v.ws } }, body: { status: v.status } as never })),
    onSuccess: async (_d, v) => {
      await refresh();
      toast.success(t(v.status === "ARCHIVED" ? "org.archived" : "org.restored"));
    },
  });
  const all = data?.workspaces ?? [];
  const active = all.filter((w) => w.status === "ACTIVE");
  const archived = all.filter((w) => w.status === "ARCHIVED");
  return (
    <Page
      title={t("org.nav.workspaces")}
      actions={
        <Button onClick={() => setCreating(true)} data-testid="org-new-workspace">
          <Plus className="size-4" aria-hidden /> {t("templates.new")}
        </Button>
      }
    >
      <p className="-mt-2 text-sm text-muted-foreground">{t("org.workspaces.intro")}</p>
      {creating ? <NewWorkspace onClose={() => setCreating(false)} /> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      <Card>
        {isPending ? (
          <SkeletonRows rows={4} />
        ) : active.length === 0 ? (
          <EmptyState icon={Building2} title={t("org.workspaces.empty")} body={t("org.workspaces.emptyBody")} action={<Button size="sm" onClick={() => setCreating(true)}>{t("templates.new")}</Button>} />
        ) : (
          <WorkspaceTable rows={active} actions={(w) => (
            <>
              <Button size="sm" variant="outline" asChild>
                <Link to="/w/$ws/home" params={{ ws: w.id }}>{t("org.open")}</Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => status.mutate({ ws: w.id, status: "ARCHIVED" })} data-testid="org-archive">
                <Archive className="size-4" aria-hidden /> {t("org.archive")}
              </Button>
            </>
          )} />
        )}
      </Card>
      {archived.length > 0 ? (
        <Card title={t("org.archivedTitle", { count: archived.length })}>
          <p className="mb-3 text-sm text-muted-foreground">{t("org.archivedIntro")}</p>
          <WorkspaceTable rows={archived} actions={(w) => (
            <>
              <Button size="sm" variant="outline" onClick={() => status.mutate({ ws: w.id, status: "ACTIVE" })} data-testid="org-restore">
                <ArchiveRestore className="size-4" aria-hidden /> {t("org.restore")}
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleting(w)} data-testid="org-delete">
                <Trash2 className="size-4" aria-hidden /> {t("org.delete")}
              </Button>
            </>
          )} />
        </Card>
      ) : null}
      {deleting ? <DeleteWorkspace ws={deleting} onClose={() => setDeleting(null)} onDeleted={refresh} /> : null}
    </Page>
  );
}

function WorkspaceTable({ rows, actions }: { rows: OrgWorkspace[]; actions: (w: OrgWorkspace) => ReactElement }): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="org-workspaces">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2 pr-3 font-medium">{t("org.col.name")}</th>
            <th className="py-2 pr-3 font-medium">{t("org.col.status")}</th>
            <th className="py-2 pr-3 font-medium">{t("org.col.admins")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("org.col.members")}</th>
            <th className="py-2 pr-3 text-right font-medium">{t("org.col.budgets")}</th>
            <th className="py-2 pr-3 font-medium">{t("org.col.activity")}</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id} className="border-t border-border" data-testid="org-workspace" data-name={w.name}>
              <td className="py-2.5 pr-3">
                <span className="block font-medium">{w.name}</span>
                <span className="block text-xs text-muted-foreground">{w.slug} · {w.currency}</span>
              </td>
              <td className="py-2.5 pr-3">
                <StatusChip status={w.status} label={t(w.status === "ARCHIVED" ? "status.word.ARCHIVED" : "status.word.ACTIVE")} />
              </td>
              <td className="py-2.5 pr-3 text-muted-foreground">{w.admins.length ? w.admins.map((a) => a.name).join(", ") : <span className="text-warning-text">{t("org.noAdmin")}</span>}</td>
              <td className="tabular py-2.5 pr-3 text-right">{w.members}</td>
              <td className="tabular py-2.5 pr-3 text-right">{w.budgets}</td>
              <td className="py-2.5 pr-3 text-muted-foreground">{when(w.lastActivityAt ?? w.createdAt)}</td>
              <td className="py-2.5">
                <div className="flex justify-end gap-1">{actions(w)}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const Template = z.object({ id: z.string().uuid(), name: z.string(), description: z.string().nullable() }).passthrough();
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, i, 1)).toLocaleDateString(undefined, { month: "long", timeZone: "UTC" }));

function NewWorkspace({ onClose }: { onClose: () => void }): ReactElement {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { data: templates = [] } = useQuery({ queryKey: ["workspace-templates"], queryFn: async () => z.array(Template).parse(await unwrap(api.GET("/api/v1/workspace-templates", {}))) });
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [month, setMonth] = useState(1);
  const [templateId, setTemplateId] = useState("");
  const [demo, setDemo] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const chosen = templateId || templates[0]?.id || "";
  const create = useMutation({
    meta: { success: t("org.created") },
    mutationFn: async () =>
      z.object({ id: z.string() }).passthrough().parse(
        await unwrap(api.POST("/api/v1/workspaces", { body: { name: name.trim(), templateId: chosen, withDemoData: demo, reportingCurrency: currency, fiscalYearStartMonth: month, ...(adminEmail.trim() ? { firstAdmin: { email: adminEmail.trim(), name: adminName.trim() || adminEmail.trim() } } : {}) } as never })),
      ),
    onSuccess: async (w) => {
      await Promise.all([client.invalidateQueries({ queryKey: ["me"] }), client.invalidateQueries({ queryKey: ["org-workspaces"] })]);
      void navigate({ to: "/w/$ws/home", params: { ws: w.id } });
    },
  });
  const emailOk = adminEmail.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail.trim());
  const why = !name.trim() ? t("templates.needName") : !/^[A-Z]{3}$/.test(currency) ? t("org.needCurrency") : !chosen ? t("templates.needTemplate") : !emailOk ? t("org.needEmail") : create.isPending ? t("templates.creating") : null;
  return (
    <Card title={t("templates.new")}>
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!why) create.mutate();
        }}
        data-testid="org-create-form"
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{t("templates.name")}</span>
          <Input className={field} value={name} onChange={(e) => setName(e.target.value.slice(0, 120))} placeholder={t("templates.namePlaceholder")} autoFocus data-testid="org-create-name" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{t("org.template")}</span>
          <Select className={field} value={chosen} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{t("workspace.currency")}</span>
          <Input className={cn(field, "uppercase")} value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">{t("workspace.fiscalStart")}</span>
          <Select className={field} value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </Select>
        </label>
        <fieldset className="flex flex-col gap-2 rounded-xl border border-border p-4 md:col-span-2">
          <legend className="px-1 text-sm font-medium">{t("org.firstAdmin")}</legend>
          <p className="text-sm text-muted-foreground">{t("org.firstAdminHelp")}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Input className={field} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="name@company.com" aria-label={t("roles.email")} data-testid="org-create-admin-email" />
            <Input className={field} value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder={t("roles.name")} aria-label={t("roles.name")} data-testid="org-create-admin-name" />
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm md:col-span-2">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} data-testid="org-create-demo" />
          {t("templates.withDemo")}
        </label>
        {create.error ? <p role="alert" className="text-sm text-destructive md:col-span-2">{create.error.message}</p> : null}
        <div className="flex justify-end gap-2 md:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t("profile.cancel")}</Button>
          {why ? <Button type="button" disabled reason={why}>{t("templates.create")}</Button> : <Button type="submit" data-testid="org-create-submit">{t("templates.create")}</Button>}
        </div>
      </form>
    </Card>
  );
}

function DeleteWorkspace({ ws, onClose, onDeleted }: { ws: OrgWorkspace; onClose: () => void; onDeleted: () => Promise<unknown> }): ReactElement {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const remove = useMutation({
    meta: { success: t("org.deleted", { name: ws.name }) },
    mutationFn: async () => unwrap(api.DELETE("/api/v1/workspaces/{ws}", { params: { path: { ws: ws.id } }, body: { confirmName: typed, reason: reason.trim() } as never })),
    onSuccess: async () => (await onDeleted(), onClose()),
  });
  const why = typed !== ws.name ? t("org.deleteTypeName") : !reason.trim() ? t("org.deleteNeedReason") : remove.isPending ? t("shell.loading") : null;
  return (
    <div role="alertdialog" aria-labelledby="delete-ws-title" className="rounded-2xl border border-destructive/40 bg-danger-soft/40 p-5" data-testid="org-delete-dialog">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-danger-soft text-danger-text">
          <Trash2 className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <p id="delete-ws-title" className="font-semibold">{t("org.deleteTitle", { name: ws.name })}</p>
            <p className="text-sm text-muted-foreground">{t("org.deleteBody")}</p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("org.deleteType", { name: ws.name })}</span>
            <Input className={field} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus data-testid="org-delete-name" />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t("org.deleteReason")}</span>
            <Input className={field} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="org-delete-reason" />
          </label>
          {remove.error ? <p role="alert" className="text-sm text-destructive">{remove.error.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              <X className="size-4" aria-hidden /> {t("profile.cancel")}
            </Button>
            {why ? <Button variant="destructive" disabled reason={why}>{t("org.deleteConfirm")}</Button> : <Button variant="destructive" onClick={() => remove.mutate()} data-testid="org-delete-confirm">{t("org.deleteConfirm")}</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
