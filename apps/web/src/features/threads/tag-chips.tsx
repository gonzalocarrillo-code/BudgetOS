import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { meQuery } from "../../lib/queries.js";
import { appliedTagsQuery, Tag, tagsQuery, type TaggableType } from "./queries.js";

/**
 * Tag chips (spec §18.5, §13) on a budget, target, alert or approval request: the entity's tags,
 * each removable, and "add tag" with the workspace's other tags. Someone who may create tags types
 * a new name and creates it on the spot. Without `tags`, the chips read the entity's own.
 */
export function TagChips({ ws, entity, tags, onChanged, compact = false }: { ws: string; entity: { type: TaggableType; id: string }; tags?: Array<Pick<Tag, "id" | "name" | "color">>; onChanged?: () => Promise<unknown>; compact?: boolean }): ReactElement {
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const { data: me } = useQuery(meQuery);
  const mayCreate = me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("tag.create") ?? false);
  const { data: all = [] } = useQuery({ ...tagsQuery(ws), enabled: adding });
  const own = useQuery({ ...appliedTagsQuery(ws, entity.type, [entity.id]), enabled: tags === undefined });
  const current = tags ?? own.data?.[entity.id] ?? [];
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["applied-tags", ws] });
    await client.invalidateQueries({ queryKey: ["tags", ws] });
    await onChanged?.();
  };
  const change = useMutation({
    mutationFn: async ({ tagId, on }: { tagId: string; on: boolean }) => {
      const init = { params: { header: { "X-Workspace-Id": ws } }, body: { tagId, entities: [entity] } } as never;
      return on ? unwrap(api.POST("/api/v1/tags/apply", init)) : unwrap(api.DELETE("/api/v1/tags/apply", init));
    },
    onSuccess: async () => {
      setAdding(false);
      setText("");
      await refresh();
    },
  });
  const create = useMutation({
    mutationFn: async (name: string) => {
      const tag = z.object({ id: z.string().uuid() }).passthrough().parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/tags", { params: { path: { ws } }, body: { name } as never })));
      await unwrap(api.POST("/api/v1/tags/apply", { params: { header: { "X-Workspace-Id": ws } }, body: { tagId: tag.id, entities: [entity] } } as never));
    },
    onSuccess: async () => {
      setAdding(false);
      setText("");
      await refresh();
    },
  });
  const term = text.trim().toLowerCase();
  const others = all.filter((x) => !current.some((y) => y.id === x.id) && (!term || x.name.toLowerCase().includes(term)));
  const exists = all.some((x) => x.name.toLowerCase() === term);
  const error = change.error ?? create.error;
  return (
    <div className="flex flex-col gap-2" data-testid="tag-chips" data-entity={entity.type}>
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("tags.title")}>
        {current.map((tag) => (
          <li key={tag.id} className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface pl-2 pr-1 text-xs" data-testid="tag-chip">
            <span className="size-2 rounded-full" style={{ background: tag.color ?? "var(--muted-foreground)" }} aria-hidden />
            {tag.name}
            <button type="button" className="rounded-full p-0.5 hover:bg-accent" aria-label={t("tags.remove", { name: tag.name })} onClick={() => change.mutate({ tagId: tag.id, on: false })} data-testid="tag-remove">
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2 text-xs text-muted-foreground hover:bg-accent" aria-expanded={adding} onClick={() => setAdding((a) => !a)} data-testid="tag-add">
            <Plus className="size-3" aria-hidden />
            {compact && current.length ? "" : t("tags.add")}
          </button>
        </li>
      </ul>
      {adding ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2" data-testid="tag-picker">
          <input className="h-8 rounded-md border border-input bg-card px-2 text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={mayCreate ? t("tags.findOrCreate") : t("tags.find")} autoFocus data-testid="tag-find" />
          {others.length ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={t("tags.add")} data-testid="tag-options">
              {others.slice(0, 30).map((tag) => (
                <li key={tag.id}>
                  <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs hover:bg-accent" onClick={() => change.mutate({ tagId: tag.id, on: true })} data-testid="tag-option">
                    <span className="size-2 rounded-full" style={{ background: tag.color ?? "var(--muted-foreground)" }} aria-hidden />
                    {tag.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {term && !exists && mayCreate ? (
            <button type="button" className="self-start rounded-md border border-primary/40 bg-secondary px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10" onClick={() => create.mutate(text.trim())} data-testid="tag-create">
              {t("tags.create", { name: text.trim() })}
            </button>
          ) : null}
          {!others.length && !(term && mayCreate) ? <p className="text-xs text-muted-foreground">{mayCreate ? t("tags.noneCreate") : t("tags.none")}</p> : null}
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive" role="alert">{error.message}</p> : null}
    </div>
  );
}
