import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { X } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { cn } from "./cn.js";
import { t } from "./i18n.js";

/**
 * Layers (DS-002): dialogs, side sheets, popovers, menus and tabs on Radix primitives (MIT). Each
 * traps focus while open, closes on Escape and an outside click, and gives focus back to what
 * opened it, which none of the hand-written panels did.
 */

// ---- Dialog: only for confirmations and short forms (plan §11.1 "modal never, except…") -------
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ title, description, children, footer, className, wide = false, ...rest }: { title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string; wide?: boolean } & Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title">): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-inverse/40 data-[state=open]:animate-[fade-in_150ms_ease-out]" />
      <DialogPrimitive.Content
        className={cn("fixed left-1/2 top-[12vh] z-50 flex max-h-[80vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-2xl border border-border bg-card shadow-xl outline-none", wide ? "max-w-2xl" : "max-w-lg", className)}
        {...(description ? {} : { "aria-describedby": undefined })}
        {...rest}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-[15px] font-semibold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("layer.close")}>
            <X className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * A frame for a screen's own modal card (DS-002): the backdrop, focus kept inside, Escape and a
 * click on the backdrop close it, and focus returns to what opened it. `labelledBy` points at the
 * card's own heading, or `label` names it. Extra `data-*` attributes land on the frame (tests and styling).
 */
export function Modal({ onClose, labelledBy, label, testId, children, className, ...data }: { onClose: () => void; labelledBy?: string; label?: string; testId?: string; children: ReactNode; className?: string } & { [k: `data-${string}`]: string | undefined }): ReactElement {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-inverse/30" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
          className={cn("fixed inset-0 z-40 grid place-items-center overflow-y-auto p-6 outline-none", className)}
          onMouseDown={(e) => (e.target === e.currentTarget ? onClose() : undefined)}
          data-testid={testId}
          {...data}
        >
          <DialogPrimitive.Title className="sr-only">{label ?? t("layer.dialog")}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ---- Sheet: a panel from the right edge, for work beside a list ----------------------------------
export function SheetContent({ title, description, children, footer, className, ...rest }: { title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string } & Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title">): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-inverse/25" />
      <DialogPrimitive.Content className={cn("fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-card shadow-xl outline-none", className)} {...(description ? {} : { "aria-describedby": undefined })} {...rest}>
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-[15px] font-semibold">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("layer.close")}>
            <X className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ---- Popover ------------------------------------------------------------------------------------
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;
export function PopoverContent({ className, align = "end", sideOffset = 6, ...props }: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>): ReactElement {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content align={align} sideOffset={sideOffset} className={cn("z-50 w-72 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none", className)} {...props} />
    </PopoverPrimitive.Portal>
  );
}

// ---- Dropdown menu ------------------------------------------------------------------------------
export const Menu = DropdownPrimitive.Root;
export const MenuTrigger = DropdownPrimitive.Trigger;
export function MenuContent({ className, align = "end", sideOffset = 6, ...props }: ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>): ReactElement {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content align={align} sideOffset={sideOffset} className={cn("z-50 min-w-56 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none", className)} {...props} />
    </DropdownPrimitive.Portal>
  );
}
export function MenuItem({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownPrimitive.Item>): ReactElement {
  return <DropdownPrimitive.Item className={cn("flex cursor-pointer select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[disabled]:opacity-50", className)} {...props} />;
}
export function MenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>): ReactElement {
  return <DropdownPrimitive.Label className={cn("px-2.5 pb-1 pt-1.5 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground", className)} {...props} />;
}
export function MenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>): ReactElement {
  return <DropdownPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}

// ---- Tabs ---------------------------------------------------------------------------------------
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;
/** `variant="pill"` is the segmented control (views, filters); `"line"` sits under a page or panel header. */
export function TabsList({ className, variant = "pill", ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: "pill" | "line" }): ReactElement {
  return <TabsPrimitive.List data-variant={variant} className={cn("group/tabs inline-flex items-center", variant === "pill" ? "gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5" : "gap-1 border-b border-border", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>): ReactElement {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        "group-data-[variant=pill]/tabs:h-7 group-data-[variant=pill]/tabs:rounded-md group-data-[variant=pill]/tabs:px-3 group-data-[variant=pill]/tabs:data-[state=active]:bg-card group-data-[variant=pill]/tabs:data-[state=active]:font-medium group-data-[variant=pill]/tabs:data-[state=active]:text-foreground group-data-[variant=pill]/tabs:data-[state=active]:shadow-xs",
        "group-data-[variant=line]/tabs:-mb-px group-data-[variant=line]/tabs:border-b-2 group-data-[variant=line]/tabs:border-transparent group-data-[variant=line]/tabs:px-2 group-data-[variant=line]/tabs:py-2 group-data-[variant=line]/tabs:data-[state=active]:border-primary group-data-[variant=line]/tabs:data-[state=active]:font-medium group-data-[variant=line]/tabs:data-[state=active]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
