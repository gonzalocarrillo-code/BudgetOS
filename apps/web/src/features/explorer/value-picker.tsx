import { cn, Input } from "@budget/ui";
import { t } from "@budget/ui/i18n";
import { Check, Search, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

/**
 * A filter's values as a searchable dropdown (owner feedback, 2026-09-30): type to narrow the list
 * by name or code, pick with a click or Enter (several allowed), remove a pick from its pill.
 * Keyboard: ↑ ↓ move, Enter picks, Escape closes, Backspace on an empty box removes the last pick.
 */
export interface PickerValue {
  code: string;
  label: string;
}

const MAX_SHOWN = 50;
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function ValuePicker({ values, picked, onChange, placeholder, testId = "filter-values" }: { values: PickerValue[]; picked: string[]; onChange: (codes: string[]) => void; placeholder: string; testId?: string }): ReactElement {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const labelOf = (code: string) => values.find((v) => v.code === code)?.label ?? code;
  // Names that start with the text first, then those that contain it; codes match too.
  const matches = useMemo(() => {
    const q = fold(query.trim());
    const pool = values.filter((v) => !picked.includes(v.code));
    if (!q) return pool.slice(0, MAX_SHOWN);
    const starts = pool.filter((v) => fold(v.label).startsWith(q) || fold(v.code).startsWith(q));
    const contains = pool.filter((v) => !starts.includes(v) && (fold(v.label).includes(q) || fold(v.code).includes(q)));
    return [...starts, ...contains].slice(0, MAX_SHOWN);
  }, [values, picked, query]);
  const pick = (code: string) => {
    onChange([...picked, code]);
    setQuery("");
    setActive(0);
    input.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const m = matches[active];
      if (open && m) {
        e.preventDefault();
        pick(m.code);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "Backspace" && query === "" && picked.length) {
      onChange(picked.slice(0, -1));
    }
  };
  return (
    <div className="relative min-w-56 max-w-md flex-1" data-testid={testId}>
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input bg-card px-2 py-0.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20" onClick={() => input.current?.focus()}>
        {picked.map((code) => (
          <span key={code} className="inline-flex h-6 items-center gap-1 rounded-full bg-secondary pl-2 pr-0.5 text-xs text-secondary-foreground" data-testid="filter-value-picked">
            {labelOf(code)}
            <button type="button" className="grid size-5 place-items-center rounded-full hover:bg-primary/10" aria-label={t("explorer.filter.removeValue", { label: labelOf(code) })} onClick={() => onChange(picked.filter((c) => c !== code))}>
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <span className="flex min-w-24 flex-1 items-center gap-1.5">
          {picked.length === 0 ? <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
          <Input
            ref={input}
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={placeholder}
            className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none hover:border-0 focus:ring-0"
            placeholder={picked.length ? "" : placeholder}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setOpen(true), setActive(0))}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKey}
            data-testid={`${testId}-search`}
          />
        </span>
      </div>
      {open ? (
        <ul id={listId} role="listbox" aria-multiselectable="true" className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-lg" data-testid={`${testId}-list`}>
          {matches.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">{query ? t("explorer.filter.noMatch", { q: query }) : t("explorer.filter.allPicked")}</li>
          ) : (
            matches.map((v, i) => (
              <li
                key={v.code}
                role="option"
                aria-selected={i === active}
                className={cn("flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5", i === active ? "bg-accent" : "hover:bg-accent/60")}
                // Before the input's blur closes the list.
                onMouseDown={(e) => (e.preventDefault(), pick(v.code))}
                onMouseEnter={() => setActive(i)}
                data-testid="filter-value-option"
                data-value={v.code}
              >
                <span className="truncate">{v.label}</span>
                {v.label !== v.code ? <span className="shrink-0 text-xs text-muted-foreground">{v.code}</span> : <Check className="size-3.5 opacity-0" aria-hidden />}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
