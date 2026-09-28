import type { HTMLAttributes, ReactElement, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn.js";

/** Initials on a colour picked from the id, so a person keeps their colour everywhere (DS-002). */
const TINTS = ["bg-info-soft text-info-text", "bg-success-soft text-success-text", "bg-warning-soft text-warning-text", "bg-danger-soft text-danger-text", "bg-neutral-soft text-neutral-text", "bg-secondary text-secondary-foreground"];
export function Avatar({ name, id, size = 28, className }: { name: string; id?: string; size?: number; className?: string }): ReactElement {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";
  const seed = [...(id ?? name)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span aria-hidden className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold", TINTS[seed % TINTS.length], className)} style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}>
      {initials}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }): ReactElement {
  return <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-card px-1 font-sans text-[11px] text-muted-foreground", className)}>{children}</kbd>;
}

/**
 * Table primitives (DS-004): one header style, row height, hover and numeric alignment for every
 * list screen. Sorting, filtering and totals stay on the server (AGENTS §4); these only draw rows.
 */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>): ReactElement {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}
export const THead = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): ReactElement => <thead className={cn("text-left text-xs font-medium text-muted-foreground", className)} {...props} />;
export const TBody = ({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): ReactElement => <tbody className={cn("[&>tr]:border-t [&>tr]:border-border", className)} {...props} />;
export const TR = ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>): ReactElement => <tr className={cn("group/row transition-colors hover:bg-accent/40 data-[selected=true]:bg-secondary", className)} {...props} />;
export const TH = ({ className, numeric = false, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }): ReactElement => <th className={cn("whitespace-nowrap px-2 py-2 font-medium first:pl-0 last:pr-0", numeric && "text-right", className)} {...props} />;
export const TD = ({ className, numeric = false, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }): ReactElement => <td className={cn("px-2 py-2.5 align-middle first:pl-0 last:pr-0", numeric && "tabular whitespace-nowrap text-right", className)} {...props} />;
/** Actions that show on row hover or focus, and always on touch screens. */
export const RowActions = ({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactElement => (
  <div className={cn("flex justify-end gap-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover/row:opacity-100 lg:group-focus-within/row:opacity-100", className)} {...props} />
);
