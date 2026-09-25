import { REACTIONS, REACTION_NAMES } from "@budget/domain";
import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, History, Lock, MessageSquare, RotateCcw, SmilePlus } from "lucide-react";
import { Fragment, useState, type ReactElement } from "react";
import { api, unwrap } from "../../lib/api.js";
import { meQuery } from "../../lib/queries.js";
import { CommentEditor, emptyDraft, initials, type Draft } from "./comment-editor.js";
import { bodyParts, fromCanonical, type Names } from "./mentions.js";
import { threadsKey, threadsQuery, type AnchorType, type Comment, type Reaction, type Thread } from "./queries.js";

/**
 * The thread panel (spec §18.5, plan §8.6 / 0.6): every conversation on one anchor (a budget, a
 * target, an approval request). Comments show their author and time, mentions by name, an
 * "edited" control that opens every earlier version, and reactions by account. Open threads come
 * first; a blocking thread says so.
 */
export function ThreadPanel({ ws, anchorType, anchorId, canBlock = false }: { ws: string; anchorType: AnchorType; anchorId: string; canBlock?: boolean }): ReactElement {
  const client = useQueryClient();
  const { data: threads, isPending, error } = useQuery(threadsQuery(ws, anchorType, anchorId));
  const { data: me } = useQuery(meQuery);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [blocking, setBlocking] = useState(false);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: threadsKey(ws, anchorType, anchorId) });
    await client.invalidateQueries({ queryKey: ["timeline", ws] });
  };
  const create = useMutation({
    mutationFn: async (bodyMd: string) => unwrap(api.POST("/api/v1/threads", { params: { header: { "X-Workspace-Id": ws } }, body: { anchorType, anchorId, isBlocking: blocking, firstComment: { bodyMd } } as never })),
    onSuccess: async () => {
      setDraft(emptyDraft);
      setBlocking(false);
      await refresh();
    },
  });
  const sorted = [...(threads ?? [])].sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open"));

  return (
    <div className="flex flex-col gap-4" data-testid="thread-panel">
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3" data-tour="thread-new">
        <CommentEditor ws={ws} draft={draft} setDraft={setDraft} onSubmit={(b) => create.mutate(b)} submitLabel={t("threads.start")} placeholder={t("threads.start.placeholder")} pending={create.isPending} testId="new-thread" />
        {canBlock ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} data-testid="new-thread-blocking" />
            {t("threads.blocking.option")}
          </label>
        ) : null}
        {create.error ? <p className="text-xs text-destructive" role="alert">{create.error.message}</p> : null}
      </div>
      {error ? <p className="text-sm text-destructive" role="alert">{error.message}</p> : null}
      {isPending ? <p className="text-sm text-muted-foreground">{t("shell.loading")}</p> : null}
      {threads && threads.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="threads-empty">
          <MessageSquare className="size-4" aria-hidden />
          {t("threads.none")}
        </p>
      ) : null}
      {sorted.map((th) => (
        <ThreadCard key={th.id} ws={ws} thread={th} meId={me?.user.id ?? null} refresh={refresh} />
      ))}
    </div>
  );
}

function ThreadCard({ ws, thread, meId, refresh }: { ws: string; thread: Thread; meId: string | null; refresh: () => Promise<void> }): ReactElement {
  const [reply, setReply] = useState<Draft | null>(null);
  const resolved = thread.status !== "open";
  const H = { params: { path: { id: thread.id }, header: { "X-Workspace-Id": ws } } };
  const post = useMutation({
    mutationFn: async (bodyMd: string) => unwrap(api.POST("/api/v1/threads/{id}/comments", { ...H, body: { bodyMd } as never })),
    onSuccess: async () => {
      setReply(null);
      await refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: async () => (resolved ? unwrap(api.POST("/api/v1/threads/{id}/reopen", H as never)) : unwrap(api.POST("/api/v1/threads/{id}/resolve", H as never))),
    onSuccess: refresh,
  });
  const err = post.error ?? toggle.error;
  return (
    <article className={cn("rounded-lg border p-3", resolved ? "border-border bg-surface" : "border-border bg-card")} aria-label={thread.title ?? t("threads.thread")} data-testid="thread">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {thread.isBlocking && !resolved ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 font-medium text-foreground" data-testid="thread-blocking">
            <Lock className="size-3" aria-hidden />
            {t("threads.blocking")}
          </span>
        ) : null}
        {resolved ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 font-medium" data-testid="thread-resolved">
            <CheckCircle2 className="size-3" aria-hidden />
            {t("threads.resolved", { name: thread.resolvedBy ? (thread.names.users[thread.resolvedBy] ?? "—") : "—" })}
          </span>
        ) : null}
        {thread.title ? <span className="font-medium">{thread.title}</span> : null}
        <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs" onClick={() => toggle.mutate()} data-testid={resolved ? "thread-reopen" : "thread-resolve"}>
          {resolved ? <RotateCcw className="size-3.5" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
          {t(resolved ? "threads.reopen" : "threads.resolve")}
        </Button>
      </header>
      <ol className="flex flex-col gap-3">
        {thread.comments.map((c) => (
          <li key={c.id}>
            <CommentItem ws={ws} comment={c} names={thread.names} mine={c.authorId === meId} refresh={refresh} />
          </li>
        ))}
      </ol>
      {err ? <p className="mt-2 text-xs text-destructive" role="alert">{err.message}</p> : null}
      <div className="mt-3">
        {reply ? (
          <CommentEditor ws={ws} draft={reply} setDraft={setReply} onSubmit={(b) => post.mutate(b)} onCancel={() => setReply(null)} submitLabel={t("threads.reply")} placeholder={t("threads.reply.placeholder")} pending={post.isPending} testId="reply" />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setReply(emptyDraft)} data-testid="thread-reply">
            {t("threads.reply")}
          </Button>
        )}
      </div>
    </article>
  );
}

function CommentItem({ ws, comment: c, names, mine, refresh }: { ws: string; comment: Comment; names: Names; mine: boolean; refresh: () => Promise<void> }): ReactElement {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const author = names.users[c.authorId] ?? "—";
  const H = { params: { path: { id: c.id }, header: { "X-Workspace-Id": ws } } };
  const edit = useMutation({
    mutationFn: async (bodyMd: string) => unwrap(api.PATCH("/api/v1/comments/{id}", { ...H, body: { bodyMd } as never })),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });
  const remove = useMutation({ mutationFn: async () => unwrap(api.DELETE("/api/v1/comments/{id}", H as never)), onSuccess: refresh });
  const historyId = `history-${c.id}`;

  if (c.deletedAt) {
    return <p className="text-sm italic text-muted-foreground" data-testid="comment-deleted">{t("threads.deleted", { name: author })}</p>;
  }
  return (
    <div className="flex gap-2" data-testid="comment">
      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-secondary-foreground" aria-hidden>
        {initials(author)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="text-sm font-medium" data-testid="comment-author">{author}</span>
          <time className="text-muted-foreground" dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time>
          {c.editedAt ? (
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:underline" aria-expanded={showHistory} aria-controls={historyId} onClick={() => setShowHistory((s) => !s)} data-testid="comment-edited">
              <History className="size-3" aria-hidden />
              {t("threads.edited", { n: c.editHistory.length })}
            </button>
          ) : null}
        </div>
        {editing ? (
          <div className="mt-1">
            <CommentEditor ws={ws} draft={editing} setDraft={setEditing} onSubmit={(b) => edit.mutate(b)} onCancel={() => setEditing(null)} submitLabel={t("threads.save")} placeholder={t("threads.edit.placeholder")} pending={edit.isPending} testId="edit-comment" />
          </div>
        ) : (
          <p className="mt-0.5 whitespace-pre-line break-words text-sm" data-testid="comment-body">
            <Body body={c.bodyMd ?? ""} names={names} />
          </p>
        )}
        {showHistory ? (
          <ol id={historyId} className="mt-2 flex flex-col gap-2 border-l-2 border-border pl-3" aria-label={t("threads.history")} data-testid="comment-history">
            {[...c.editHistory].reverse().map((h, i) => (
              <li key={h.editedAt + String(i)} className="text-xs">
                <span className="text-muted-foreground">{t("threads.history.entry", { when: new Date(h.editedAt).toLocaleString() })}</span>
                <p className="whitespace-pre-line text-sm text-muted-foreground line-through decoration-muted-foreground/40" data-testid="comment-history-body">
                  <Body body={h.bodyMd} names={names} />
                </p>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Reactions ws={ws} comment={c} refresh={refresh} />
          {mine && !editing ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setEditing(fromCanonical(c.bodyMd ?? "", names))} data-testid="comment-edit">
                {t("threads.edit")}
              </Button>
              {confirmDelete ? (
                <>
                  <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => remove.mutate()} data-testid="comment-delete-confirm">
                    {t("threads.delete.confirm")}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirmDelete(false)}>
                    {t("threads.cancel")}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setConfirmDelete(true)} data-testid="comment-delete">
                  {t("threads.delete")}
                </Button>
              )}
            </>
          ) : null}
        </div>
        {edit.error ?? remove.error ? <p className="text-xs text-destructive" role="alert">{(edit.error ?? remove.error)?.message}</p> : null}
      </div>
    </div>
  );
}

function Body({ body, names }: { body: string; names: Names }): ReactElement {
  return (
    <>
      {bodyParts(body, names).map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <span key={i} className="rounded bg-secondary px-1 font-medium text-secondary-foreground" data-testid="mention">
            @{p.name}
          </span>
        ),
      )}
    </>
  );
}

/** Reactions by account: a chip per emoji (pressed when it is yours; its name lists who), and a picker. */
function Reactions({ ws, comment: c, refresh }: { ws: string; comment: Comment; refresh: () => Promise<void> }): ReactElement {
  const [picking, setPicking] = useState(false);
  const react = useMutation({
    mutationFn: async ({ emoji, on }: { emoji: string; on: boolean }) => {
      const init = { params: { path: { id: c.id }, header: { "X-Workspace-Id": ws } }, body: { emoji } } as never;
      return on ? unwrap(api.POST("/api/v1/comments/{id}/reactions", init)) : unwrap(api.DELETE("/api/v1/comments/{id}/reactions", init));
    },
    onSuccess: async () => {
      setPicking(false);
      await refresh();
    },
  });
  const label = (r: Reaction) => t(r.mine ? "threads.reaction.labelMine" : "threads.reaction.label", { emoji: r.emoji, name: r.name, count: r.count, who: r.users.map((u) => u.name).join(", ") });
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="reactions">
      {c.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          aria-pressed={r.mine}
          aria-label={label(r)}
          title={r.users.map((u) => u.name).join(", ")}
          className={cn("inline-flex h-7 items-center gap-1 rounded-full border px-2 text-xs", r.mine ? "border-primary bg-secondary text-secondary-foreground" : "border-border bg-card hover:bg-accent")}
          onClick={() => react.mutate({ emoji: r.emoji, on: !r.mine })}
          data-testid="reaction"
          data-emoji={r.emoji}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="tabular" aria-hidden>{r.count}</span>
        </button>
      ))}
      <Button variant="ghost" size="sm" className="h-7 px-2" aria-label={t("threads.reaction.add")} aria-expanded={picking} onClick={() => setPicking((p) => !p)} data-testid="reaction-add">
        <SmilePlus className="size-4" aria-hidden />
      </Button>
      {picking ? (
        <div role="group" aria-label={t("threads.reaction.add")} className="flex gap-0.5 rounded-full border border-border bg-popover px-1 shadow-sm" data-testid="reaction-picker">
          {REACTIONS.map((emoji) => {
            const mine = c.reactions.some((r) => r.emoji === emoji && r.mine);
            return (
              <button key={emoji} type="button" aria-label={REACTION_NAMES[emoji]} aria-pressed={mine} className="size-7 rounded-full text-base hover:bg-accent" onClick={() => react.mutate({ emoji, on: !mine })} data-testid={`react-${REACTION_NAMES[emoji].replace(/\s/g, "-")}`}>
                {emoji}
              </button>
            );
          })}
        </div>
      ) : null}
      {react.error ? <span className="text-xs text-destructive" role="alert">{react.error.message}</span> : null}
    </div>
  );
}
