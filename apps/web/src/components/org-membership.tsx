import type { OrgWorkspacesResponse } from "@budget/domain";
import { Button, Dialog, DialogContent, Input, Popover, PopoverContent, PopoverTrigger, Select } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { useState, type MouseEvent, type ReactElement } from "react";
import { api, unwrap } from "../lib/api.js";

/**
 * Round 11 (PR 3): org console membership, shared between org.people.tsx (per person) and
 * org.workspaces.tsx (per workspace, inside the Members drawer). Both ends of the same two
 * mutations: `PUT /org/people/:id/workspaces/:wsId` sets a person's direct roles in one workspace
 * (empty list removes them), and `POST /org/people` invites someone straight into one workspace
 * with a role (D4: the per-workspace audit row needs one).
 */

export const ROLES = ["VIEWER", "PLANNER", "BUDGET_OWNER", "APPROVER", "FINANCE", "DATA_ADMIN", "WORKSPACE_ADMIN"] as const;
export const roleLabel = (r: string) => t(`role.${r.toLowerCase()}` as "role.viewer");

export function useSetWorkspaceRoles(invalidateKey: string[]): ReturnType<typeof useMutation<unknown, Error, { userId: string; workspaceId: string; roles: string[] }>> {
  const client = useQueryClient();
  return useMutation({
    meta: { error: true },
    mutationFn: async (v: { userId: string; workspaceId: string; roles: string[] }) =>
      unwrap(api.PUT("/api/v1/org/people/{id}/workspaces/{wsId}", { params: { path: { id: v.userId, wsId: v.workspaceId } }, body: { roles: v.roles } as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: invalidateKey }),
  });
}

/** A workspace chip with its roles, a popover to change them, and × to remove — disabled with a reason when `viaGroup`. */
export function WorkspaceChip({ userId, workspaceId, name, roles, viaGroup, onChanged }: { userId: string; workspaceId: string; name: string; roles: string[]; viaGroup: boolean; onChanged: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<string[]>(roles);
  const set = useSetWorkspaceRoles(["org-people"]);
  const toggle = (r: string) => setChecked((c) => (c.includes(r) ? c.filter((x) => x !== r) : [...c, r]));
  const save = () => set.mutate({ userId, workspaceId, roles: checked }, { onSuccess: () => (setOpen(false), onChanged()) });
  const remove = () => set.mutate({ userId, workspaceId, roles: [] }, { onSuccess: onChanged });
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs" data-testid="org-person-workspace">
      <Popover open={open} onOpenChange={(o) => (setOpen(o), o && setChecked(roles))}>
        <PopoverTrigger asChild>
          <button type="button" className="inline-flex items-center gap-1 hover:text-primary" data-testid="org-person-workspace-open">
            <Link to="/w/$ws/admin/roles" params={{ ws: workspaceId }} className="font-medium hover:underline" onClick={(e: MouseEvent) => e.stopPropagation()}>
              {name}
            </Link>
            <span className="text-muted-foreground">{roles.map(roleLabel).join(", ")}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t("org.people.changeRoles", { ws: name })}</p>
          <div className="flex flex-col gap-1.5">
            {ROLES.map((r) => (
              <label key={r} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={checked.includes(r)} onChange={() => toggle(r)} disabled={viaGroup} title={viaGroup ? t("org.people.viaGroup") : ""} />
                {roleLabel(r)}
              </label>
            ))}
          </div>
          {set.error ? <p role="alert" className="mt-2 text-xs text-destructive">{set.error.message}</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("profile.cancel")}</Button>
            {viaGroup ? (
              <Button size="sm" disabled reason={t("org.people.viaGroup")}>{t("profile.save")}</Button>
            ) : (
              <Button size="sm" onClick={save} data-testid="org-person-workspace-save">{t("profile.save")}</Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {viaGroup ? (
        <Button variant="ghost" size="sm" className="size-4 shrink-0 p-0" disabled reason={t("org.people.viaGroup")} aria-label={t("org.people.removeFrom", { ws: name })}>
          <X className="size-3" aria-hidden />
        </Button>
      ) : (
        <button
          type="button"
          className="rounded p-0.5 hover:bg-accent"
          aria-label={t("org.people.removeFrom", { ws: name })}
          data-testid="org-person-remove-ws"
          onClick={() => {
            if (window.confirm(t("org.people.removeConfirm", { name, ws: name }))) remove();
          }}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** "+ Add to workspace": a popover with the workspaces the person isn't in yet, and a role. */
export function AddToWorkspace({ userId, exclude, onChanged }: { userId: string; exclude: string[]; onChanged: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["org-workspaces-for-add"], queryFn: async () => (await unwrap(api.GET("/api/v1/workspaces", {}))) as OrgWorkspacesResponse });
  const choices = (data?.workspaces ?? []).filter((w) => w.status === "ACTIVE" && !exclude.includes(w.id));
  const [workspaceId, setWorkspaceId] = useState("");
  const [role, setRole] = useState<string>("VIEWER");
  const set = useSetWorkspaceRoles(["org-people"]);
  const chosen = workspaceId || choices[0]?.id || "";
  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), o && (setWorkspaceId(""), setRole("VIEWER")))}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="org-person-add-ws" data-tour="org-people-add-ws">
          <Plus className="size-3.5" aria-hidden /> {t("org.people.addToWorkspace")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        {choices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("org.people.noWorkspace")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t("org.col.name")}</span>
              <Select value={chosen} onChange={(e) => setWorkspaceId(e.target.value)}>
                {choices.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">{t("roles.role")}</span>
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{roleLabel(r)}</option>
                ))}
              </Select>
            </label>
            {set.error ? <p role="alert" className="text-xs text-destructive">{set.error.message}</p> : null}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t("profile.cancel")}</Button>
              <Button size="sm" onClick={() => set.mutate({ userId, workspaceId: chosen, roles: [role] }, { onSuccess: () => (setOpen(false), onChanged()) })} data-testid="org-person-add-ws-save">
                {t("org.people.addToWorkspace")}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** "Invite person": name, email, workspace and role, straight from the org console. */
export function InvitePerson({ open, onOpenChange, onDone, defaultWorkspaceId }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void; defaultWorkspaceId?: string }): ReactElement {
  const { data } = useQuery({ queryKey: ["org-workspaces-for-add"], queryFn: async () => (await unwrap(api.GET("/api/v1/workspaces", {}))) as OrgWorkspacesResponse });
  const choices = (data?.workspaces ?? []).filter((w) => w.status === "ACTIVE");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [role, setRole] = useState<string>("VIEWER");
  const chosen = workspaceId || defaultWorkspaceId || choices[0]?.id || "";
  const invite = useMutation({
    meta: { error: true },
    mutationFn: async () => unwrap(api.POST("/api/v1/org/people", { body: { name: name.trim(), email: email.trim(), workspaceId: chosen, role } as never })),
    onSuccess: () => (setName(""), setEmail(""), onOpenChange(false), onDone()),
  });
  const valid = /^\S+@\S+\.\S+$/.test(email.trim()) && name.trim() !== "" && chosen !== "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("org.people.inviteTitle")} data-testid="org-people-invite-dialog">
        <div className="flex flex-col gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("roles.name")}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="org-invite-name" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("roles.email")}</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" data-testid="org-invite-email" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("org.col.name")}</span>
            <Select value={chosen} onChange={(e) => setWorkspaceId(e.target.value)} data-testid="org-invite-workspace">
              {choices.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">{t("roles.role")}</span>
            <Select value={role} onChange={(e) => setRole(e.target.value)} data-testid="org-invite-role">
              {ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </Select>
          </label>
          {invite.error ? <p role="alert" className="text-sm text-destructive">{invite.error.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("profile.cancel")}</Button>
            {valid && !invite.isPending ? (
              <Button onClick={() => invite.mutate()} data-testid="org-invite-submit">{t("org.people.invite")}</Button>
            ) : (
              <Button disabled reason={t("roles.needPerson")}>{t("org.people.invite")}</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
