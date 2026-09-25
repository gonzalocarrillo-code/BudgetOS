import { Button } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { useState, type FormEvent, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { savedViewsQuery, type SavedView } from "../../lib/queries.js";

/** Saved views (spec §18.3): save the current search params under a name; loading one replaces them. */
export function SavedViews({ ws, current, onLoad, onSaved }: { ws: string; current: Record<string, unknown>; onLoad: (v: SavedView) => void; onSaved: (name: string) => void }): ReactElement {
  const client = useQueryClient();
  const { data: views = [] } = useQuery(savedViewsQuery(ws));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: async (n: string) => unwrap(api.POST("/api/v1/workspaces/{ws}/saved-views", { params: { path: { ws } }, body: { name: n, screen: "explorer", definition: current, visibility: "private" } as never })),
    onSuccess: async (_, n) => {
      await client.invalidateQueries({ queryKey: ["saved-views", ws] });
      setNaming(false);
      setName("");
      onSaved(n);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) save.mutate(name.trim());
  };
  return (
    <div className="flex items-center gap-2">
      <select
        className="h-8 rounded-md border border-input bg-card px-2 text-sm"
        aria-label={t("explorer.views")}
        value=""
        onChange={(e) => {
          const v = views.find((x) => x.id === e.target.value);
          if (v) onLoad(v);
        }}
        data-testid="saved-views"
      >
        <option value="">{views.length ? t("explorer.views") : t("explorer.views.none")}</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {naming ? (
        <form onSubmit={submit} className="flex items-center gap-2">
          <input autoFocus className="h-8 w-40 rounded-md border border-input bg-card px-2 text-sm" placeholder={t("explorer.views.name")} aria-label={t("explorer.views.name")} value={name} onChange={(e) => setName(e.target.value)} data-testid="saved-view-name" />
          {name.trim() ? (
            <Button size="sm" type="submit" data-testid="saved-view-submit">
              {t("explorer.views.save")}
            </Button>
          ) : (
            <Button size="sm" type="submit" disabled reason={t("explorer.views.name")}>
              {t("explorer.views.save")}
            </Button>
          )}
        </form>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setNaming(true)} data-testid="saved-view-save" data-tour="save-view">
          <Star className="size-4" aria-hidden />
          {t("explorer.views.save")}
        </Button>
      )}
    </div>
  );
}
