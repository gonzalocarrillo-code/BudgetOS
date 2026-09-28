import { NotificationsResponse, type NotificationItem } from "@budget/domain";
import { Button, Popover, PopoverContent, PopoverTrigger, cn } from "@budget/ui";
import { t, type MessageKey } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AtSign, Bell, BellRing, CircleCheck, MessageSquare } from "lucide-react";
import { useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";

/**
 * The header bell (DS-003): the in-app notifications the notify worker already writes (approvals
 * to decide and their outcomes, alerts assigned to you, mentions, thread activity). Opening one
 * marks it read and goes to it; "Mark all read" clears the count.
 */
const notificationsQuery = (ws: string) => ({
  queryKey: ["notifications", ws],
  queryFn: async () => NotificationsResponse.parse(await unwrap(api.GET("/api/v1/me/notifications", { params: { header: { "X-Workspace-Id": ws } } }))),
  refetchInterval: 60_000,
});

const ICON = { approval_requested: CircleCheck, approval_outcome: CircleCheck, alert: BellRing, mention: AtSign, thread_activity: MessageSquare } as const;
const KNOWN = new Set(Object.keys(ICON));

function target(ws: string, n: NotificationItem): string {
  const p = n.payload;
  if (typeof p["requestId"] === "string") return `/w/${ws}/approvals/${p["requestId"]}`;
  if (n.kind === "alert") return `/w/${ws}/alerts`;
  const anchorType = p["anchorType"];
  const anchorId = p["anchorId"];
  if (anchorType === "approval_request" && typeof anchorId === "string") return `/w/${ws}/approvals/${anchorId}`;
  if (anchorType === "envelope" && typeof anchorId === "string") return `/w/${ws}/budgets?select=${encodeURIComponent(JSON.stringify(anchorId))}`;
  return `/w/${ws}/home`;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return t("notify.now");
  if (mins < 60) return t("notify.minutes", { n: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t("notify.hours", { n: hours });
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function NotificationBell({ ws }: { ws: string }): ReactElement {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useQuery(notificationsQuery(ws));
  const read = useMutation({
    mutationFn: async (ids?: string[]) => unwrap(api.POST("/api/v1/me/notifications/read", { params: { header: { "X-Workspace-Id": ws } }, body: (ids ? { ids } : {}) as never })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notifications", ws] }),
  });
  const unread = data?.unread ?? 0;
  const rows = data?.rows ?? [];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? t("notify.labelCount", { count: unread }) : t("notify.label")} data-testid="notifications">
          <Bell className="size-4" aria-hidden />
          {unread > 0 ? (
            <span className="absolute right-1 top-1 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[11px] font-semibold leading-4 text-white" data-testid="notifications-count">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" data-testid="notifications-panel">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-semibold">{t("notify.title")}</span>
          {unread > 0 ? (
            <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => read.mutate(undefined)} data-testid="notifications-read-all">
              {t("notify.readAll")}
            </button>
          ) : null}
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("notify.empty")}</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto py-1">
            {rows.map((n) => {
              const Icon = ICON[n.kind as keyof typeof ICON] ?? Bell;
              const kind = KNOWN.has(n.kind) ? n.kind : "other";
              const status = typeof n.payload["kind"] === "string" ? String(n.payload["kind"]) : "";
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cn("flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm hover:bg-accent", n.readAt === null && "bg-secondary/60")}
                    onClick={() => {
                      if (n.readAt === null) read.mutate([n.id]);
                      setOpen(false);
                      void navigate({ href: target(ws, n) });
                    }}
                    data-testid="notification"
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block">{t(`notify.kind.${kind}` as MessageKey, { status })}</span>
                      <span className="block text-xs text-muted-foreground">{ago(n.createdAt)}</span>
                    </span>
                    {n.readAt === null ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label={t("notify.unread")} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
