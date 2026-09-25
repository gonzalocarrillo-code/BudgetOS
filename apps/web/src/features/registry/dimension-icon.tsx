import { cn } from "@budget/ui";
import { useQuery } from "@tanstack/react-query";
import { Shapes } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic.mjs";
import { useEffect, useState, type ReactElement } from "react";
import { z } from "zod";
import { api, unwrap } from "../../lib/api.js";

/**
 * Spec §8's icon contract: `lucide:<name>` renders that Lucide icon (loaded on demand, so the
 * library costs nothing until an icon is shown); `asset:icons/<id>.svg` renders an uploaded,
 * sanitized SVG, fetched with the caller's token and shown through an <img> (no script runs).
 */
export function DimensionIcon({ ws, icon, className }: { ws: string; icon: string; className?: string }): ReactElement {
  const cls = cn("size-4 shrink-0", className);
  if (icon.startsWith("lucide:")) {
    const name = icon.slice("lucide:".length);
    return isIconName(name) ? <DynamicIcon name={name} className={cls} aria-hidden fallback={() => <Shapes className={cls} aria-hidden />} /> : <Shapes className={cls} aria-hidden />;
  }
  if (icon.startsWith("asset:icons/")) return <AssetIcon ws={ws} file={icon.slice("asset:icons/".length)} className={cls} />;
  return <Shapes className={cls} aria-hidden />;
}

const names = new Set<string>(iconNames);
export const isIconName = (name: string): name is IconName => names.has(name);
export { iconNames };

export const iconQuery = (ws: string, file: string) => ({
  queryKey: ["icon", ws, file],
  queryFn: async () => z.object({ svg: z.string() }).parse(await unwrap(api.GET("/api/v1/assets/icons/{file}", { params: { path: { file }, header: { "X-Workspace-Id": ws } } }))),
  staleTime: Infinity,
});

function AssetIcon({ ws, file, className }: { ws: string; file: string; className: string }): ReactElement {
  const { data } = useQuery(iconQuery(ws, file));
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return undefined;
    const u = URL.createObjectURL(new Blob([data.svg], { type: "image/svg+xml" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data]);
  return url ? <img src={url} alt="" className={className} /> : <Shapes className={className} aria-hidden />;
}
