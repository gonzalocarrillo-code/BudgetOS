import { PeopleResponse } from "@budget/domain";
import { Button, cn, Input, Select } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, ShieldCheck, UserPlus, Users, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery, registryQuery } from "../lib/queries.js";

/**
 * Roles and access (spec §7, plan §7; product feedback 6): who can do what in this workspace.
 * Everyone in the org and every group, with their roles here; a role is for the whole workspace or
 * only some values of one granularity (e.g. Region: LATAM). An org admin adds people by email so
 * a role can be given before they first sign in. Changes apply on the next request.
 */
export const Route = createFileRoute("/w/$ws/admin/roles")({ component: RolesPage });

const ROLES = ["VIEWER", "PLANNER", "BUDGET_OWNER", "APPROVER", "FINANCE", "DATA_ADMIN", "WORKSPACE_ADMIN"] as const;
const roleLabel = (r: string) => t(`role.${r.toLowerCase()}` as MessageKey);
const field = "";
type Scope = { logic?: string; children?: Array<{ field?: { key?: string }; value?: string | string[] }> };

const membersQuery = (ws: string) => ({
  queryKey: ["members", ws],
  queryFn: async () => PeopleResponse.parse(await unwrap(api.GET("/api/v1/workspaces/{ws}/members", { params: { path: { ws } } }))),
});

function RolesPage(): ReactElement {
  const { ws } = Route.useParams();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const canManage = me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("user.manage") ?? false);
  const { data, error } = useQuery({ ...membersQuery(ws), enabled: canManage });
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => (setProblem(null), client.invalidateQueries({ queryKey: ["members", ws] }));
  const revoke = useMutation({
    meta: { success: t("toast.roleRemoved"), error: true },
    mutationFn: async (id: string) => unwrap(api.DELETE("/api/v1/roles/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } } })),
    onSuccess: refresh,
    onError: (e: Error) => setProblem(e.message),
  });
  const label = (dim: string, code: string) => dims.find((d) => d.key === dim)?.values.find((v) => v.code === code)?.label ?? code;
  const scopeText = (scope: unknown) => {
    const s = scope as Scope;
    const parts = (s.children ?? []).map((c) => {
      const key = c.field?.key ?? "";
      const values = Array.isArray(c.value) ? c.value : c.value ? [c.value] : [];
      return `${dims.find((d) => d.key === key)?.label ?? key}: ${values.map((v) => label(key, v)).join(", ")}`;
    });
    return parts.length ? parts.join(" · ") : t("roles.everything");
  };

  if (!canManage) {
    return (
      <Page title={t("admin.roles")}>
        <Card>
          <p className="text-sm text-muted-foreground" data-testid="roles-forbidden">{t("roles.noPermission")}</p>
        </Card>
      </Page>
    );
  }

  const principals: Array<{ type: "user" | "group"; id: string; name: string; sub: string; badges: string[]; roles: Array<{ id: string; role: string; scope?: unknown }> }> = [
    ...(data?.users ?? []).map((u) => ({ type: "user" as const, id: u.id, name: u.name, sub: u.email, badges: [...(u.orgAdmin ? [t("roles.orgAdmin")] : []), ...(!u.signedIn ? [t("roles.notSignedIn")] : []), ...(!u.isActive ? [t("roles.inactive")] : [])], roles: u.roles })),
    ...(data?.groups ?? []).map((g) => ({ type: "group" as const, id: g.id, name: g.name, sub: t("roles.groupMembers", { count: g.memberCount, email: g.googleGroup }), badges: [t("roles.group")], roles: g.roles })),
  ];

  return (
    <Page title={t("admin.roles")}>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("roles.intro")}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      {problem ? <p role="alert" className="text-sm text-destructive" data-testid="roles-error">{problem}</p> : null}
      {canManage ? <AddPerson ws={ws} superadmin={me?.isOrgAdmin === true} onDone={refresh} /> : null}
      <Card title={t("roles.people", { count: principals.length })}>
        <ul className="flex flex-col divide-y divide-border" data-testid="principals">
          {principals.map((p) => (
            <li key={`${p.type}-${p.id}`} className="flex flex-col gap-2 py-3" data-testid="principal" data-email={p.type === "user" ? p.sub : ""} data-name={p.name}>
              <div className="flex flex-wrap items-center gap-2">
                {p.type === "group" ? <Users className="size-4 text-muted-foreground" aria-hidden /> : null}
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.sub}</span>
                {p.badges.map((b) => (
                  <span key={b} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{b}</span>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {p.roles.length === 0 ? <span className="text-xs text-muted-foreground">{t("roles.none")}</span> : null}
                {p.roles.map((r) => (
                  <span key={r.id} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-0.5 text-xs" data-testid="role-chip" data-role={r.role}>
                    <ShieldCheck className="size-3.5 text-primary" aria-hidden />
                    <span className="font-medium">{roleLabel(r.role)}</span>
                    <span className="text-muted-foreground">{scopeText(r.scope)}</span>
                    <button type="button" className="ml-0.5 rounded p-0.5 hover:bg-accent" onClick={() => revoke.mutate(r.id)} aria-label={t("roles.revoke", { role: roleLabel(r.role), name: p.name })} data-testid="role-revoke">
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
                <AddRole ws={ws} principal={p} onDone={refresh} onError={setProblem} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </Page>
  );
}

function AddRole({ ws, principal, onDone, onError }: { ws: string; principal: { type: "user" | "group"; id: string; roles: Array<{ role: string }> }; onDone: () => void; onError: (m: string) => void }): ReactElement {
  const { data: dims = [] } = useQuery(registryQuery(ws));
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<string>("PLANNER");
  const [dim, setDim] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const assign = useMutation({
    meta: { success: t("toast.roleGiven") },
    mutationFn: async () => {
      const scope = dim && values.length ? { logic: "and", children: [{ field: { kind: "dimension", key: dim }, op: "descends_from", value: values }] } : {};
      return unwrap(api.POST("/api/v1/workspaces/{ws}/roles", { params: { path: { ws } }, body: { principalType: principal.type, principalId: principal.id, role, scope } as never }));
    },
    onSuccess: () => (setOpen(false), setDim(""), setValues([]), onDone()),
    onError: (e: Error) => onError(e.message),
  });
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="role-add">
        <Plus className="size-3.5" aria-hidden />{t("roles.add")}
      </Button>
    );
  }
  const dimension = dims.find((d) => d.key === dim);
  const taken = principal.roles.some((r) => r.role === role);
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2 text-sm" data-testid="role-form">
      <Select className={field} value={role} onChange={(e) => setRole(e.target.value)} aria-label={t("roles.role")} data-testid="role-select">
        {ROLES.map((r) => (
          <option key={r} value={r}>{roleLabel(r)}</option>
        ))}
      </Select>
      <span className="text-muted-foreground">{t("roles.for")}</span>
      <Select className={field} value={dim} onChange={(e) => (setDim(e.target.value), setValues([]))} aria-label={t("roles.scope")} data-testid="role-scope-dim">
        <option value="">{t("roles.everything")}</option>
        {dims.filter((d) => d.values.length > 0).map((d) => (
          <option key={d.key} value={d.key}>{t("roles.only", { dimension: d.label })}</option>
        ))}
      </Select>
      {dimension ? (
        <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto" data-testid="role-scope-values">
          {dimension.values.map((v) => (
            <label key={v.code} className={cn("inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-xs", values.includes(v.code) ? "border-primary bg-secondary" : "border-border")}>
              <input type="checkbox" className="accent-[var(--color-primary)]" checked={values.includes(v.code)} onChange={(e) => setValues((vs) => (e.target.checked ? [...vs, v.code] : vs.filter((x) => x !== v.code)))} data-testid={`role-value-${v.code}`} />
              {v.label}
            </label>
          ))}
        </div>
      ) : null}
      {taken ? (
        <Button size="sm" disabled reason={t("roles.taken")}>{t("roles.give")}</Button>
      ) : dim && values.length === 0 ? (
        <Button size="sm" disabled reason={t("roles.pickValues")}>{t("roles.give")}</Button>
      ) : assign.isPending ? (
        <Button size="sm" disabled reason={t("shell.loading")}>{t("roles.give")}</Button>
      ) : (
        <Button size="sm" onClick={() => assign.mutate()} data-testid="role-give">{t("roles.give")}</Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("paste.cancel")}</Button>
    </div>
  );
}

/**
 * ORG-005: a workspace admin adds someone to this workspace by work email, with a role here (the
 * person joins the organization if they are new to it). A superadmin may add someone with no role yet.
 */
function AddPerson({ ws, superadmin, onDone }: { ws: string; superadmin: boolean; onDone: () => void }): ReactElement {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(superadmin ? "" : "VIEWER");
  const [note, setNote] = useState<string | null>(null);
  const add = useMutation({
    meta: { success: t("toast.personAdded") },
    mutationFn: async () => z.object({ created: z.boolean(), email: z.string() }).parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/members", { params: { path: { ws } }, body: { email, name, ...(role ? { role } : {}) } as never }))),
    onSuccess: (r) => (setNote(r.created ? t("roles.added", { email: r.email }) : t("roles.already", { email: r.email })), setEmail(""), setName(""), onDone()),
  });
  const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && name.trim() !== "";
  return (
    <Card title={t("roles.addPerson")}>
      <div className="flex flex-col gap-2 text-sm">
        <p className="text-muted-foreground">{t("roles.addPersonHelp")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-56 flex-1 flex-col gap-1">
            <span className="text-muted-foreground">{t("roles.email")}</span>
            <Input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" data-testid="person-email" />
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            <span className="text-muted-foreground">{t("roles.name")}</span>
            <Input className={field} value={name} onChange={(e) => setName(e.target.value)} data-testid="person-name" />
          </label>
          <label className="flex min-w-40 flex-col gap-1">
            <span className="text-muted-foreground">{t("roles.role")}</span>
            <Select className={field} value={role} onChange={(e) => setRole(e.target.value)} data-testid="person-role">
              {superadmin ? <option value="">{t("roles.noRoleYet")}</option> : null}
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          </label>
          {valid && !add.isPending ? (
            <Button onClick={() => add.mutate()} data-testid="person-add"><UserPlus className="size-4" aria-hidden />{t("roles.addButton")}</Button>
          ) : (
            <Button disabled reason={t("roles.needPerson")}><UserPlus className="size-4" aria-hidden />{t("roles.addButton")}</Button>
          )}
        </div>
        {note ? <p className="text-success" role="status" data-testid="person-note">{note}</p> : null}
        {add.error ? <p role="alert" className="text-destructive">{add.error.message}</p> : null}
      </div>
    </Card>
  );
}
