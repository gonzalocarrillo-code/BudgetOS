import { OrgPeopleResponse } from "@budget/domain";
import { Button, Chip, EmptyState, SkeletonRows, StatusChip } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ShieldCheck, Users } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Org console › People (ADR-052): everyone in the organization, where they hold roles, and
 * whether they can sign in. Roles are given inside each workspace (its Roles page); here a
 * superadmin deactivates someone who left, or brings them back.
 */
export const Route = createFileRoute("/org/people")({ component: PeoplePage });

const roleLabel = (r: string) => t(`role.${r.toLowerCase()}` as "role.viewer");

function PeoplePage(): ReactElement {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data, isPending, error } = useQuery({ queryKey: ["org-people"], queryFn: async () => OrgPeopleResponse.parse(await unwrap(api.GET("/api/v1/org/people", {}))) });
  const [q, setQ] = useState("");
  const active = useMutation({
    meta: { error: true },
    mutationFn: async (v: { id: string; isActive: boolean }) => unwrap(api.PATCH("/api/v1/org/people/{id}", { params: { path: { id: v.id } }, body: { isActive: v.isActive } as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["org-people"] }),
  });
  const needle = q.trim().toLowerCase();
  const people = (data?.people ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle));
  return (
    <Page title={t("org.nav.people")}>
      <p className="-mt-2 text-sm text-muted-foreground">{t("org.people.intro")}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      <Card>
        <input className="mb-3 h-9 w-full max-w-sm rounded-lg border border-input bg-card px-3 text-sm outline-none focus:border-ring" placeholder={t("org.people.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("org.people.search")} data-testid="org-people-search" />
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
                </span>
                <span className="flex min-w-0 flex-[2] flex-wrap gap-1.5">
                  {p.workspaces.length === 0 ? <span className="text-sm text-muted-foreground">{t("org.people.noWorkspace")}</span> : null}
                  {p.workspaces.map((w) => (
                    <Link key={w.workspaceId} to="/w/$ws/admin/roles" params={{ ws: w.workspaceId }} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-primary/50">
                      <span className="font-medium">{w.name}</span>
                      <span className="text-muted-foreground">{w.roles.map(roleLabel).join(", ")}</span>
                    </Link>
                  ))}
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
