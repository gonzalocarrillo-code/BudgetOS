import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag as TagIcon, X } from "lucide-react";
import { useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";
import { meQuery } from "../../lib/queries.js";
import { tagsQuery } from "../threads/queries.js";

/**
 * Tag many budgets at once (product feedback 2026-09-28): the rows ticked in the grid's select
 * mode get a tag, or lose one, in one call (POST/DELETE /tags/apply, up to 10k). A new tag can be
 * created on the spot by someone who may create tags.
 */
export function BulkTagBar({ ws, envelopeIds, onDone, onExit }: { ws: string; envelopeIds: string[]; onDone: (message: string) => void; onExit: () => void }): ReactElement {
  const client = useQueryClient();
  const { data: tags = [] } = useQuery(tagsQuery(ws));
  const { data: me } = useQuery(meQuery);
  const mayCreate = me?.isOrgAdmin === true || (me?.workspaces.find((w) => w.workspaceId === ws)?.permissions.includes("tag.create") ?? false);
  const [tagName, setTagName] = useState("");
  const existing = tags.find((x) => x.name.toLowerCase() === tagName.trim().toLowerCase()) ?? null;
  const run = useMutation({
    mutationFn: async (mode: "add" | "remove") => {
      let tagId = existing?.id ?? null;
      if (tagId === null) {
        if (mode === "remove" || !mayCreate) throw new Error(t("bulkTag.unknown", { name: tagName.trim() }));
        tagId = z.object({ id: z.string().uuid() }).passthrough().parse(await unwrap(api.POST("/api/v1/workspaces/{ws}/tags", { params: { path: { ws } }, body: { name: tagName.trim() } as never }))).id;
      }
      const init = { params: { header: { "X-Workspace-Id": ws } }, body: { tagId, entities: envelopeIds.map((id) => ({ type: "envelope", id })) } } as never;
      const r = z.object({ changed: z.number() }).passthrough().parse(await unwrap(mode === "add" ? api.POST("/api/v1/tags/apply", init) : api.DELETE("/api/v1/tags/apply", init)));
      return { mode, changed: r.changed };
    },
    onSuccess: async ({ mode, changed }) => {
      await client.invalidateQueries({ queryKey: ["tags", ws] });
      await client.invalidateQueries({ queryKey: ["applied-tags", ws] });
      await client.invalidateQueries({ queryKey: ["envelope", ws] });
      onDone(t(mode === "add" ? "bulkTag.added" : "bulkTag.removed", { count: changed, name: tagName.trim() }));
      setTagName("");
    },
  });
  const none = envelopeIds.length === 0 ? t("bulkTag.pickRows") : null;
  const noTag = tagName.trim() === "" ? t("bulkTag.pickTag") : null;
  const why = none ?? noTag ?? (run.isPending ? t("shell.loading") : null);
  const addWhy = why ?? (existing === null && !mayCreate ? t("bulkTag.cannotCreate") : null);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-secondary px-3 py-2 text-sm" role="toolbar" aria-label={t("bulkTag.title")} data-testid="bulk-tag-bar">
      <TagIcon className="size-4 text-primary" aria-hidden />
      <span className="font-medium" data-testid="bulk-tag-count">{t("bulkTag.selected", { count: envelopeIds.length })}</span>
      <input list="bulk-tag-names" className="h-8 w-48 rounded-md border border-input bg-card px-2 text-sm" value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder={mayCreate ? t("tags.findOrCreate") : t("tags.find")} aria-label={t("bulkTag.tag")} data-testid="bulk-tag-name" />
      <datalist id="bulk-tag-names">
        {tags.map((x) => (
          <option key={x.id} value={x.name} />
        ))}
      </datalist>
      {addWhy ? (
        <Button size="sm" disabled reason={addWhy}>{existing === null && tagName.trim() ? t("bulkTag.createAndTag") : t("bulkTag.tag")}</Button>
      ) : (
        <Button size="sm" onClick={() => run.mutate("add")} data-testid="bulk-tag-add">{existing === null ? t("bulkTag.createAndTag") : t("bulkTag.tag")}</Button>
      )}
      {why || existing === null ? (
        <Button size="sm" variant="outline" disabled reason={why ?? t("bulkTag.unknown", { name: tagName.trim() })}>{t("bulkTag.untag")}</Button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => run.mutate("remove")} data-testid="bulk-tag-remove">{t("bulkTag.untag")}</Button>
      )}
      {run.error ? <span className="text-destructive" role="alert">{run.error.message}</span> : null}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onExit} data-testid="bulk-tag-exit">
        <X className="size-4" aria-hidden />
        {t("bulkTag.done")}
      </Button>
    </div>
  );
}
