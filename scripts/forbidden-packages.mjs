// Commercial components that must never enter the tree (AGENTS.md §4, plan §3.9): SVAR PRO, AG Grid,
// Bryntum, Syncfusion, MUI X Pro/Premium, TipTap Pro. Used by eslint (`no-restricted-imports`) and by
// scripts/license-check.mjs (the production dependency tree). `glob` is eslint's pattern syntax.
export const FORBIDDEN_PACKAGES = [
  { name: "SVAR PRO", regex: /^@svar\//, glob: "@svar/*" },
  // `pro` as a whole name segment (@svar-ui/react-gantt-pro, @svar-ui/pro-…), not `provider`.
  { name: "SVAR PRO", regex: /^@svar-ui\/(.+-)?pro(-.+)?$/i, glob: "@svar-ui/*-pro" },
  { name: "SVAR PRO", regex: /^@svar-ui\/(.+-)?pro(-.+)?$/i, glob: "@svar-ui/pro-*" },
  { name: "SVAR PRO", regex: /^@svar-ui\/(.+-)?pro(-.+)?$/i, glob: "@svar-ui/*-pro-*" },
  { name: "AG Grid", regex: /^(@ag-grid-[^/]+\/|ag-grid)/, glob: "ag-grid*" },
  { name: "AG Grid", regex: /^@ag-grid-/, glob: "@ag-grid-*/*" },
  { name: "Bryntum", regex: /^(@bryntum\/|bryntum)/, glob: "@bryntum/*" },
  { name: "Syncfusion", regex: /^@syncfusion\//, glob: "@syncfusion/*" },
  { name: "MUI X Pro/Premium", regex: /^@mui\/x-[a-z-]+-(pro|premium)$/, glob: "@mui/x-*-pro" },
  { name: "MUI X Pro/Premium", regex: /^@mui\/x-[a-z-]+-(pro|premium)$/, glob: "@mui/x-*-premium" },
  { name: "TipTap Pro", regex: /^@tiptap-pro\//, glob: "@tiptap-pro/*" },
];

export const forbiddenMatch = (name) => FORBIDDEN_PACKAGES.find((f) => f.regex.test(name)) ?? null;
