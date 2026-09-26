import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { FORBIDDEN_PACKAGES } from "./scripts/forbidden-packages.mjs";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**", "**/coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // AGENTS.md §4: no commercial components, no SVAR PRO (spec §23.2); license-check guards the tree too.
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: FORBIDDEN_PACKAGES.map((f) => ({ group: [f.glob], message: `${f.name} is a commercial package (AGENTS.md §4). Implement it in @budget/grid or @budget/timeline.` })) },
      ],
    },
  },
);
