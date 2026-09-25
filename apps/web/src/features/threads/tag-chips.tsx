import { t } from "@budget/ui/i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { tagsQuery, type Tag } from "./queries.js";

/**
 * Tag chips (spec §18.5, §13): the entity's tags, each removable, and an "add tag" list of the
 * workspace's other tags. Creating tags is the admin's (Admin → Tags); here they are applied.
 */
export function TagChips({ ws, entity, tags, onChanged }: { ws: string; entity: { type: "envelope"; id: string }; tags: Array<Pick<Tag, "id" | "name" | "color">>; onChanged: () => Promise<void> }): ReactElement {
  const [adding, setAdding] = useState(false);
  const { data: all = [] } = useQuery({ ...tagsQuery(ws), enabled: adding });
  const change = useMutation({
    mutationFn: async ({ tagId, on }: { tagId: string; on: boolean }) => {
      const init = { params: { header: { "X-Workspace-Id": ws } }, body: { tagId, entities: [entity] } } as never;
      return on ? unwrap(api.POST("/api/v1/tags/apply", init)) : unwrap(api.DELETE("/api/v1/tags/apply", init));
    },
    onSuccess: async () => {
      setAdding(false);
      await onChanged();
    },
  });
  const others = all.filter((x) => !tags.some((y) => y.id === x.id));
  return (
    <div className="flex flex-col gap-2" data-testid="tag-chips">
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("tags.title")}>
        {tags.map((tag) => (
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
            {t("tags.add")}
          </button>
        </li>
      </ul>
      {adding ? (
        others.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("tags.none")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("tags.add")} data-testid="tag-options">
            {others.map((tag) => (
              <li key={tag.id}>
                <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs hover:bg-accent" onClick={() => change.mutate({ tagId: tag.id, on: true })} data-testid="tag-option">
                  <span className="size-2 rounded-full" style={{ background: tag.color ?? "var(--muted-foreground)" }} aria-hidden />
                  {tag.name}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {change.error ? <p className="text-xs text-destructive" role="alert">{change.error.message}</p> : null}
    </div>
  );
}
