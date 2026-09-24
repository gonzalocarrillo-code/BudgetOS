import type { GoldenTotals } from "./golden.plan.js";

/**
 * Expected totals for the golden workspace (spec §21), from `goldenPlan(GOLDEN_SEED)`.
 * Committed as literals so a change to the plan or to the code that loads it shows up as a diff.
 * Used by the golden planner tests now, and by MCP and closure tests later. Amounts are reporting
 * currency (USD) decimal strings; leaf totals filter `audience not_empty` (only leaves have one).
 *
 * Regenerate after an intentional plan change: see apps/api/src/seed/golden.test.ts.
 */
export const GOLDEN_ASSERTIONS: GoldenTotals = {
  "envelopes": {
    "total": 330,
    "leaves": 192,
    "parents": 138
  },
  "approvedVersions": 714,
  "leafBudget": {
    "2026-02-01": {
      "total": "1072300.00",
      "byRegion": {
        "EMEA": "529600.00",
        "LATAM": "542700.00"
      }
    },
    "2026-05-01": {
      "total": "1094086.50",
      "byRegion": {
        "EMEA": "540757.00",
        "LATAM": "553329.50"
      }
    },
    "2026-08-01": {
      "total": "1107799.19",
      "byRegion": {
        "EMEA": "542425.82",
        "LATAM": "565373.37"
      }
    },
    "current": {
      "total": "1107799.19",
      "byRegion": {
        "EMEA": "542425.82",
        "LATAM": "565373.37"
      }
    }
  },
  "leafBudgetCurrent": {
    "byCountry": {
      "AR": "134668.74",
      "BR": "125587.43",
      "CO": "155313.04",
      "DE": "138459.75",
      "ES": "118712.75",
      "FR": "143558.75",
      "GB": "141694.57",
      "MX": "149804.16"
    },
    "byPlatform": {
      "amazon": "286510.45",
      "google_ads": "300030.60",
      "meta": "265759.00",
      "tiktok": "255499.14"
    },
    "byObjective": {
      "awareness": "359432.99",
      "consideration": "364555.08",
      "conversion": "383811.12"
    }
  },
  "parentBudget": {
    "byRegion": {
      "EMEA": "682013.00",
      "LATAM": "704001.00"
    }
  },
  "leafPhasingByQuarter": {
    "Q1": "257624.82",
    "Q2": "257624.82",
    "Q3": "257624.82",
    "Q4": "334924.73"
  }
};
