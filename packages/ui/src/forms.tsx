import { ChevronDown } from "lucide-react";
import { forwardRef, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "./cn.js";

/**
 * Form controls (DS-001, docs/UX_AUDIT_AND_ADMIN_PLAN.md §2.3). One height, radius, border and
 * focus ring for every field, replacing the thirteen hand-written variants. `Select` stays a
 * native <select> (keyboard, screen readers and type-ahead come for free), styled to match.
 */
export const fieldClass =
  "w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-[inset_0_1px_1px_rgb(16_24_40/0.04)] outline-none transition-colors placeholder:text-muted-foreground/80 hover:border-muted-foreground/40 focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus:ring-destructive/20";

type Size = "sm" | "md";
const height = (size: Size) => (size === "sm" ? "h-8" : "h-9");

export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: Size }>(function Input({ className, size = "md", ...props }, ref) {
  return <input ref={ref} className={cn(fieldClass, height(size), className)} {...props} />;
});

/** Money and counts: tabular figures, a decimal keypad on phones, right-aligned. */
export const NumberInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type"> & { size?: Size }>(function NumberInput({ className, size = "md", ...props }, ref) {
  return <input ref={ref} type="text" inputMode="decimal" autoComplete="off" className={cn(fieldClass, height(size), "tabular text-right", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(fieldClass, "min-h-20 py-2 leading-5", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: Size; wrapperClassName?: string }>(function Select({ className, wrapperClassName, size = "md", children, multiple, ...props }, ref) {
  // A multiple select is a list box: its own height, no chevron.
  if (multiple) {
    return (
      <span className={cn("relative inline-flex", wrapperClassName)}>
        <select ref={ref} multiple className={cn(fieldClass, "h-24 py-1", className)} {...props}>
          {children}
        </select>
      </span>
    );
  }
  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <select ref={ref} className={cn(fieldClass, height(size), "cursor-pointer appearance-none pr-8", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </span>
  );
});

/**
 * A labelled field: the label, the control, then help or the error. The control gets the ids it
 * needs (`id`, `aria-describedby`, `aria-invalid`) through the render prop.
 */
export function FormField({ label, help, error, className, children }: { label: ReactNode; help?: ReactNode; error?: ReactNode; className?: string; children: (ids: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }): ReactElement {
  const id = useId();
  const hintId = `${id}-hint`;
  const hint = error ?? help;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 text-sm", className)}>
      <label htmlFor={id} className="font-medium text-foreground">
        {label}
      </label>
      {children({ id, ...(hint ? { "aria-describedby": hintId } : {}), ...(error ? { "aria-invalid": true } : {}) })}
      {hint ? (
        <p id={hintId} className={cn("text-xs", error ? "text-danger-text" : "text-muted-foreground")} role={error ? "alert" : undefined}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
