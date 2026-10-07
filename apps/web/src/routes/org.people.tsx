import { OrgPeopleResponse } from "@budget/domain";
import { Button, Chip, EmptyState, SkeletonRows, StatusChip, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck, UserPlus, Users } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { AddToWorkspace, InvitePerson, WorkspaceChip } from "../components/org-membership.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";
import { relativeTime } from "../lib/relative-time.js";

/**
 * Org console › People (ADR-052, round 11 PR 3): everyone in the organization, where they hold
 * roles, and whether they can sign in. A superadmin invites someone straight into a workspace, adds
 * or removes a person's workspace roles here, and deactivates someone who left.
 */
export const Route = createFileRoute("/org/people")({ component: PeoplePage });

function PeoplePage(): ReactElement {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data, isPending, error } = useQuery({ queryKey: ["org-people"], queryFn: async () => OrgPeopleResponse.parse(await unwrap(api.GET("/api/v1/org/people", {}))) });
  const [q, setQ] = useState("");
  const [inviting, setInviting] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ["org-people"] });
  const active = useMutation({
    meta: { error: true },
    mutationFn: async (v: { id: string; isActive: boolean }) => unwrap(api.PATCH("/api/v1/org/people/{id}", { params: { path: { id: v.id } }, body: { isActive: v.isActive } as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["org-people"] }),
  });
  const needle = q.trim().toLowerCase();
  const people = (data?.people ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle));
  return (
    <Page
      title={t("org.nav.people")}
      actions={
        <Button onClick={() => setInviting(true)} data-testid="org-people-invite" data-tour="org-people-invite">
          <UserPlus className="size-4" aria-hidden /> {t("org.people.invite")}
        </Button>
      }
    >
      <p className="-mt-2 text-sm text-muted-foreground">{t("org.people.intro")}</p>
      <InvitePerson open={inviting} onOpenChange={setInviting} onDone={refresh} />
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      <Card>
        <Input className="mb-3 w-full max-w-sm" placeholder={t("org.people.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("org.people.search")} data-testid="org-people-search" />
        {isPending ? (
          <SkeletonRows rows={5} />
        ) : people.length === 0 ? (
          <EmptyState icon={Users} title={t("org.people.empty")} />
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-testid="org-people">
            {people.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-3" data-testid="org-person" data-email={p.email}>
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-48 flex-1">
                  <span className="flex items-center gap-2 font-medium">
                    {p.name}
                    {p.superadmin ? (
                      <Chip tone="info" icon={ShieldCheck}>{t("role.org_admin")}</Chip>
                    ) : null}
                    {!p.isActive ? <StatusChip status="ARCHIVED" label={t("roles.inactive")} /> : !p.signedIn ? <StatusChip status="PENDING" label={t("roles.notSignedIn")} /> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">{p.email}</span>
                  {p.signedIn && p.lastSignInAt ? <span className="block text-xs text-muted-foreground">{t("roles.lastSeen", { when: relativeTime(p.lastSignInAt) })}</span> : null}
                </span>
                <span className="flex min-w-0 flex-[2] flex-wrap items-center gap-1.5">
                  {p.workspaces.length === 0 ? <span className="text-sm text-muted-foreground">{t("org.people.noWorkspace")}</span> : null}
                  {p.workspaces.map((w) => (
                    <WorkspaceChip key={w.workspaceId} userId={p.id} workspaceId={w.workspaceId} name={w.name} roles={w.roles} viaGroup={w.viaGroup} onChanged={refresh} />
                  ))}
                  {p.isActive ? <AddToWorkspace userId={p.id} exclude={p.workspaces.map((w) => w.workspaceId)} onChanged={refresh} /> : null}
                </span>
                {p.id === me?.user.id ? null : p.isActive ? (
                  <Button size="sm" variant="ghost" onClick={() => active.mutate({ id: p.id, isActive: false })} data-testid="org-person-deactivate">
                    {t("org.people.deactivate")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => active.mutate({ id: p.id, isActive: true })} data-testid="org-person-reactivate">
                    {t("org.people.reactivate")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
