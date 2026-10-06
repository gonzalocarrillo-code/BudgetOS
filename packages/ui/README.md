# @budget/ui — shadcn component library and design tokens

Reusable React component library built on shadcn/ui and Radix, styled with design tokens from the product screenshots. Implements spec §20 (design tokens) for consistent theming across the app.

## Running tests

```bash
pnpm --filter @budget/ui test
```

Tests cover component behavior, accessibility (a11y), and i18n. Storybook is available for visual development.

## Key features

- `src/components/` — 50+ shadcn-based components (Button, Dialog, Select, etc.)
- `src/i18n/` — ~100% translation key coverage
- `src/tokens.css` — CSS variables for colors, spacing, typography
- `src/hooks/` — usePermissions, useCurrency, useToday, etc.
- Every disabled control has a `reason` prop (eslint `budget/no-bare-disabled` enforces this)

All user-facing strings come from i18n keys. Dark mode is supported via CSS variables.
