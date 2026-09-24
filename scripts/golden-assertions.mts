// Regenerates packages/db/seed/golden.assertions.ts from the plan (run after an intentional plan change):
//   apps/api/node_modules/.bin/tsx scripts/golden-assertions.mts
import { writeFileSync } from "node:fs";
import { computeTotals, goldenPlan } from "../packages/db/seed/golden.plan.ts";

const header = `import type { GoldenTotals } from "./golden.plan.js";

/**
 * Expected totals for the golden workspace (spec §21), from \`goldenPlan(GOLDEN_SEED)\`.
 * Committed as literals so a change to the plan or to the code that loads it shows up as a diff.
 * Used by the golden planner tests now, and by MCP and closure tests later. Amounts are reporting
 * currency (USD) decimal strings; leaf totals filter \`audience not_empty\` (only leaves have one).
 *
 * Regenerate after an intentional plan change: apps/api/node_modules/.bin/tsx scripts/golden-assertions.mts
 */
export const GOLDEN_ASSERTIONS: GoldenTotals = `;
writeFileSync(new URL("../packages/db/seed/golden.assertions.ts", import.meta.url), `${header}${JSON.stringify(computeTotals(goldenPlan()), null, 2)};\n`);
