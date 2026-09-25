import { Slot } from "@radix-ui/react-slot";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactElement } from "react";
import { cn } from "./cn.js";

/**
 * shadcn Button. A disabled button must say why (AGENTS §4, spec §27): `disabled` requires
 * `reason`, shown as a tooltip; the eslint rule `budget/no-bare-disabled` (T-040) enforces it in JSX.
 */
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border border-input bg-card hover:bg-accent hover:text-accent-foreground",
        inverse: "bg-inverse text-inverse-foreground hover:bg-inverse/90",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
      },
      size: { default: "h-9 px-4 py-2", sm: "h-8 px-3", icon: "h-9 w-9" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type Base = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };
export type ButtonProps = Base & ({ disabled?: false; reason?: never } | { disabled: true; reason: string });

export function Button({ className, variant, size, asChild = false, disabled, reason, ...props }: ButtonProps): ReactElement {
  const Comp = asChild ? Slot : "button";
  const button = <Comp className={cn(buttonVariants({ variant, size }), className)} disabled={disabled === true} aria-disabled={disabled === true} {...props} />;
  if (!disabled) return button;
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span tabIndex={0} data-disabled-reason={reason}>
            {button}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="rounded-md bg-inverse px-3 py-1.5 text-xs text-inverse-foreground" sideOffset={4}>
            {reason}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
