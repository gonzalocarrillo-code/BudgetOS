# Closures (T-024, ADR-018)

## Close a period

`POST /api/v1/workspaces/<ws>/closures {"periodKey": "2026-Q1"}` (FINANCE, WORKSPACE_ADMIN, ORG_ADMIN).
- It locks every live envelope overlapping the period and writes `closures.budget_vs_actual_<ws>_<period>[_r<N>]` in BigQuery.
- 409 means the period hasn't ended, or is already closed.
- 503 means there's no closure sink: `GOOGLE_CLOUD_PROJECT` isn't set.

## Restate

`POST /api/v1/closures/<id>/restate {"reason": "…"}` (WORKSPACE_ADMIN, ORG_ADMIN).
- Envelopes get their prior status back, unless another closed closure (a month inside a closed quarter) still covers them.
- The old table stays; the next close of the period writes `_r<N>`.

## Load facts into a closed period without restating

`POST /api/v1/sources/<id>/run {"restatementOf": "<closureId>"}`. Without the flag, rows dated in a closed period are rejected with `period <key> is closed` in the rejected-rows report.

## A close fails with "Closure table … already exists"

A previous attempt wrote the table and then failed to commit. Check that no closure points at the table:

```sql
SELECT id, status FROM period_closure WHERE bq_table = '<table>';
```

If none does, drop the orphan in BigQuery (`bq rm -t closures.<table>`) and close again. Never drop a table a closure row names.

## A closure's envelopes stay LOCKED after a restatement

Find the other closed closure that still covers them:

```sql
SELECT pc.id, fp.key
FROM closure_envelope ce
JOIN period_closure pc ON pc.id = ce.closure_id
JOIN fiscal_period fp ON fp.id = pc.period_id
WHERE ce.envelope_id = '<envelope>' AND pc.status = 'closed';
```

Restate that one too.
