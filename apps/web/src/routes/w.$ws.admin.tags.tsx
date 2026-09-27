import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { GitMerge, Pencil, Plus } from "lucide-react";
import { useState, type ReactElement } from "react";
import { Card, Page } from "../components/page.js";
import { tagsQuery, type Tag } from "../features/threads/queries.js";
import { api, unwrap } from "../lib/api.js";
import { meQuery } from "../lib/queries.js";

/**
 * Tags (spec §13, plan §8.6): every tag of the workspace with how many things carry it. Create,
 * rename, recolour, or merge one into another (its budgets, targets, alerts and threads move over).
 * A tag opens the budgets that carry it.
 */
export const Route = createFileRoute("/w/$ws/admin/tags")({ component: TagsPage });

const COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#475569"];
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.:/-]{0,63}$/u;
const field = "h-8 rounded-md border border-input bg-card px-2 text-sm";
const byTag = (name: string) => ({ logic: "and", children: [{ field: { kind: "attr", key: "tag" }, op: "eq", value: name }] });

function Swatches({ value, onPick }: { value: string | null; onPick: (c: string) => void }): ReactElement {
  return (
    <div role="radiogroup" aria-label={t("tagsAdmin.color")} className="flex gap-1">
      {COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} onClick={() => onPick(c)} className={cn("size-5 rounded-full border-2", value === c ? "border-foreground" : "border-transparent")} style={{ backgroundColor: c }} data-testid="tag-color" />
      ))}
    </div>
  );
}

function TagsPage(): ReactElement {
  const { ws } = Route.useParams();
  const client = useQueryClient();
  const { data: tags = [], error } = useQuery(tagsQuery(ws));
  const { data: me } = useQuery(meQuery);
  const canManage = me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("tag.create") ?? false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(COLORS[0] as string);
  const [editing, setEditing] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["tags", ws] });
  const create = useMutation({
    mutationFn: async () => unwrap(api.POST("/api/v1/workspaces/{ws}/tags", { params: { path: { ws } }, body: { name: name.trim(), color } as never })),
    onSuccess: () => (setName(""), refresh()),
  });
  const update = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) => unwrap(api.PATCH("/api/v1/tags/{id}", { params: { path: { id }, header: { "X-Workspace-Id": ws } }, body: body as never })),
    onSuccess: () => (setEditing(null), setMerging(null), refresh()),
  });
  const problem = create.error ?? update.error;
  const valid = NAME.test(name.trim());

  return (
    <Page title={t("admin.tags")}>
      <p className="max-w-3xl text-sm text-muted-foreground">{t("tagsAdmin.intro")}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
      <Card title={t("tagsAdmin.new")}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t("tagsAdmin.name")}</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="q4-push" data-testid="tag-name" />
          </label>
          <Swatches value={color} onPick={setColor} />
          {canManage && valid && !create.isPending ? (
            <Button onClick={() => create.mutate()} data-testid="tag-create"><Plus className="size-4" aria-hidden />{t("tagsAdmin.create")}</Button>
          ) : (
            <Button disabled reason={canManage ? t("tagsAdmin.needName") : t("tagsAdmin.noPermission")}><Plus className="size-4" aria-hidden />{t("tagsAdmin.create")}</Button>
          )}
        </div>
      </Card>
      {problem ? <p role="alert" className="text-sm text-destructive" data-testid="tags-error">{problem.message}</p> : null}
      <Card title={t("tagsAdmin.all", { count: tags.length })}>
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("tagsAdmin.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-testid="tag-list">
            {tags.map((tag) => (
              <TagRow key={tag.id} ws={ws} tag={tag} others={tags.filter((x) => x.id !== tag.id)} canManage={canManage} editing={editing === tag.id} merging={merging === tag.id} onEdit={() => (setMerging(null), setEditing(tag.id))} onMerge={() => (setEditing(null), setMerging(tag.id))} onCancel={() => (setEditing(null), setMerging(null))} onSave={(body) => update.mutate({ id: tag.id, body })} busy={update.isPending} />
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}

function TagRow(props: { ws: string; tag: Tag; others: Tag[]; canManage: boolean; editing: boolean; merging: boolean; onEdit: () => void; onMerge: () => void; onCancel: () => void; onSave: (body: Record<string, unknown>) => void; busy: boolean }): ReactElement {
  const { ws, tag, others, canManage, editing, merging } = props;
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState<string | null>(tag.color);
  const [into, setInto] = useState(others[0]?.id ?? "");
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5 text-sm" data-testid="tag-row" data-name={tag.name}>
      <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color ?? "var(--color-muted-foreground)" }} aria-hidden />
      {editing ? (
        <>
          <input className={cn(field, "w-56")} value={name} onChange={(e) => setName(e.target.value)} aria-label={t("tagsAdmin.name")} data-testid="tag-rename" />
          <Swatches value={color} onPick={setColor} />
          {NAME.test(name.trim()) && !props.busy ? (
            <Button size="sm" onClick={() => props.onSave({ ...(name.trim() !== tag.name ? { name: name.trim() } : {}), ...(color !== tag.color ? { color } : {}) })} data-testid="tag-save">{t("tagsAdmin.save")}</Button>
          ) : (
            <Button size="sm" disabled reason={t("tagsAdmin.needName")}>{t("tagsAdmin.save")}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={props.onCancel}>{t("paste.cancel")}</Button>
        </>
      ) : merging ? (
        <>
          <span className="font-medium">{tag.name}</span>
          <span className="text-muted-foreground">{t("tagsAdmin.mergeInto")}</span>
          <select className={field} value={into} onChange={(e) => setInto(e.target.value)} data-testid="tag-merge-into">
            {others.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          {into && !props.busy ? (
            <Button size="sm" variant="destructive" onClick={() => props.onSave({ mergeIntoId: into })} data-testid="tag-merge-confirm">{t("tagsAdmin.mergeConfirm", { count: tag.count ?? 0 })}</Button>
          ) : (
            <Button size="sm" disabled reason={t("tagsAdmin.needOther")}>{t("tagsAdmin.mergeConfirm", { count: tag.count ?? 0 })}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={props.onCancel}>{t("paste.cancel")}</Button>
        </>
      ) : (
        <>
          <Link to="/w/$ws/budgets" params={{ ws }} search={{ filter: byTag(tag.name), view: "pivot" } as never} className="min-w-0 flex-1 truncate font-medium hover:text-primary" data-testid="tag-open">
            {tag.name}
          </Link>
          <span className="tabular-nums text-muted-foreground" data-testid="tag-count">{t("tagsAdmin.count", { count: tag.count ?? 0 })}</span>
          {canManage ? (
            <>
              <Button size="sm" variant="ghost" onClick={props.onEdit} aria-label={t("tagsAdmin.edit", { name: tag.name })} data-testid="tag-edit"><Pencil className="size-3.5" aria-hidden /></Button>
              {others.length ? (
                <Button size="sm" variant="ghost" onClick={props.onMerge} data-testid="tag-merge"><GitMerge className="size-3.5" aria-hidden />{t("tagsAdmin.merge")}</Button>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </li>
  );
}
