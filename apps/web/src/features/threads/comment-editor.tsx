import { Button, cn } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { activeMention, toCanonical, type Picked } from "./mentions.js";
import { peopleQuery, type Person } from "./queries.js";

export interface Draft {
  text: string;
  picked: Picked[];
}
export const emptyDraft: Draft = { text: "", picked: [] };

/**
 * The comment editor (spec §18.5, ADR-025): a plain textarea with @-mention autocomplete as an
 * ARIA combobox. Typing `@` lists the workspace's people and groups; ↑/↓ move, Enter or Tab picks,
 * Esc closes. The text shows `@Name`; `onSubmit` receives the canonical body. ⌘/Ctrl+Enter posts.
 */
export function CommentEditor({
  ws,
  draft,
  setDraft,
  onSubmit,
  onCancel,
  submitLabel,
  placeholder,
  pending,
  testId,
}: {
  ws: string;
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSubmit: (bodyMd: string) => void;
  onCancel?: () => void;
  submitLabel: string;
  placeholder: string;
  pending: boolean;
  testId: string;
}): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  // After a pick, the caret goes after the inserted name as soon as React commits the new text
  // (not a frame later: a key typed in between would land before it).
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    ref.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [draft.text]);
  const mention = activeMention(draft.text, caret);
  const open = mention !== null && dismissed !== mention.start;
  const { data: people = [] } = useQuery({ ...peopleQuery(ws, mention?.query ?? ""), enabled: open });
  const options = open ? people : [];

  const pick = (p: Person) => {
    if (!mention) return;
    const insert = `@${p.name} `;
    const text = draft.text.slice(0, mention.start) + insert + draft.text.slice(caret);
    const picked = draft.picked.some((x) => x.id === p.id) ? draft.picked : [...draft.picked, { type: p.type, id: p.id, name: p.name }];
    setDraft({ text, picked });
    const at = mention.start + insert.length;
    pendingCaret.current = at;
    setCaret(at);
    setActive(0);
  };
  const submit = () => {
    const body = toCanonical(draft.text.trim(), draft.picked);
    if (body) onSubmit(body);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const p = options[active];
        if (p) {
          e.preventDefault();
          pick(p);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(mention?.start ?? null);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };
  const why = pending ? t("shell.loading") : draft.text.trim() === "" ? t("threads.empty.body") : null;

  return (
    <div className="relative flex flex-col gap-2" data-testid={testId}>
      <textarea
        ref={ref}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options[active] ? `${listId}-${options[active].id}` : undefined}
        aria-label={placeholder}
        placeholder={placeholder}
        className="min-h-16 w-full rounded-lg border border-input bg-card p-2 text-sm outline-none focus:border-ring"
        value={draft.text}
        onChange={(e) => {
          setDraft({ ...draft, text: e.target.value });
          setCaret(e.target.selectionStart);
          setActive(0);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKey}
        data-testid={`${testId}-input`}
      />
      {options.length > 0 ? (
        <ul id={listId} role="listbox" aria-label={t("threads.mention.list")} className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg" data-testid="mention-options">
          {options.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${p.id}`}
              role="option"
              aria-selected={i === active}
              className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === active ? "bg-accent" : "")}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              data-testid="mention-option"
            >
              {p.type === "group" ? <Users className="size-4 text-muted-foreground" aria-hidden /> : <span className="inline-flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-secondary-foreground" aria-hidden>{initials(p.name)}</span>}
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.email ? <span className="truncate text-xs text-muted-foreground">{p.email}</span> : <span className="text-xs text-muted-foreground">{t("threads.mention.group")}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">{t("threads.editor.hint")}</span>
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("threads.cancel")}
          </Button>
        ) : null}
        {why ? (
          <Button size="sm" disabled reason={why} data-testid={`${testId}-submit`}>
            {submitLabel}
          </Button>
        ) : (
          <Button size="sm" onClick={submit} data-testid={`${testId}-submit`}>
            {submitLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
