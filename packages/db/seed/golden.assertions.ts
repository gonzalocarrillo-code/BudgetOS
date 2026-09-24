import type { GoldenTotals } from "./golden.plan.js";

/**
 * Expected totals for the golden workspace (spec §21), from `goldenPlan(GOLDEN_SEED)`.
 * Committed as literals so a change to the plan or to the code that loads it shows up as a diff.
 * Used by the golden planner tests now, and by MCP and closure tests later. Amounts are reporting
 * currency (USD) decimal strings; leaf totals filter `audience not_empty` (only leaves have one).
 *
 * Regenerate after an intentional plan change: apps/api/node_modules/.bin/tsx scripts/golden-assertions.mts
 */
export const GOLDEN_ASSERTIONS: GoldenTotals = {
  "envelopes": {
    "total": 332,
    "leaves": 192,
    "parents": 138
  },
  "approvedVersions": 717,
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
    "Q1": "257624.84",
    "Q2": "257624.82",
    "Q3": "257624.80",
    "Q4": "334924.73"
  },
  "pendingBulk": {
    "rows": 24,
    "totalsBefore": "137599.59",
    "totalsAfter": "144479.57"
  },
  "split": {
    "sourceKey": "LATAM/AR/amazon/conversion/retargeting",
    "parts": [
      {
        "name": "AR amazon conversion retargeting · Walmart",
        "retailer": "walmart",
        "amount": "6215.84"
      },
      {
        "name": "AR amazon conversion retargeting · Mercado Libre",
        "retailer": "mercado_libre",
        "amount": "4143.90"
      }
    ]
  },
  "targets": {
    "envelope": 104,
    "filter": 1,
    "leafOverrides": 96,
    "effectiveCpa": {
      "leaves": 193,
      "byRegion": {
        "EMEA": "2312.00",
        "LATAM": "2281.50"
      }
    },
    "filterRoasLeaves": 96
  },
  "facts": {
    "rowsRead": 1539,
    "rowsRejected": 3,
    "spendRows": 1536,
    "matchedSpendRows": 1528,
    "spend": "655984.46",
    "matchedSpend": "653984.46",
    "matchCoverage": "0.996951",
    "leafActualByRegion": {
      "EMEA": "322976.22",
      "LATAM": "331008.24"
    },
    "leafConversionsByRegion": {
      "EMEA": "13965.00",
      "LATAM": "14491.00"
    },
    "unmatchedTuples": 1
  },
  "pacing": {
    "days": [
      "2026-08-13",
      "2026-08-14",
      "2026-08-15"
    ],
    "openAlertsByRule": {
      "Over-pace": 8,
      "Projected overrun": 0,
      "Projected underspend near close": 0,
      "CPA over target": 102,
      "CPA far over target": 83,
      "Implied volume gap": 0
    }
  },
  "collab": {
    "tags": {
      "q4-push": 24,
      "brand-safety": 10
    },
    "threads": {
      "open": 2,
      "resolved": 1,
      "blocking": 1
    },
    "comments": 5,
    "envelopesWithOpenThreads": 1
  }
};
