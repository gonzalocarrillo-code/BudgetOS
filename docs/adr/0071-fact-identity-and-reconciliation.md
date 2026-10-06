# ADR-071: Fact identity and reconciliation

## Status

Accepted. Supersedes spec §14 pipeline step 3 (`rowHash = sha256(sourceId + JSON.stringify(sortedRow))`) and the `ON CONFLICT (workspace_id, source_row_hash, period_date)` upsert of step 4. Amends ADR-037 (`spend_month` counts only live facts) and ADR-054 (retention compares live totals).

## Context

The stack audit of 2026-10-04 found two critical faults in how facts are identified (T-1, T-2):

- **A restated row became a second fact.** The row hash covered every column, including the amount and any `UPDATED_AT` column. The upsert only fired for a byte-identical row, that is, when nothing had changed. An incremental connector (Snowflake, BigQuery with `updatedAtColumn`) re-delivers exactly the corrected rows. So a 1,000.00 row restated to 1,200.00 read as 2,200.00 spent on every screen, in pacing alerts, in Slack and in MCP. The `spend_month` trigger and the roll-up cache followed it faithfully.
- **Nothing removed a fact the source no longer had.** A deleted or re-keyed row (a campaign renamed onto a different tuple) counted forever. Reruns only ever added.

Two related findings: I-30, where the incremental `since` had no overlap window, and I-12, where a crash between 5,000-row chunks leaves partial facts visible (that one is handled in W3-4).

## Decision

**A fact's identity is its natural key, never its measure.** `normalize()` computes it (`naturalKey`):

- When the mapping has a **`row_id` column** (a new mapping role: the source table's stable primary key), the key is sha256 of the source id, the row id and the fact's part. The part is `spend`, `kpi:<metric>:<attribution>` or `projection:<metric>`.
- Otherwise the key is the **business key**: sha256 of the source id, the `period_date`, the dimension tuple with sorted keys, the raw match key and the fact's part. The same key can appear more than once in one extract, for example ad-level rows mapped only to campaign dimensions. The pipeline then appends the occurrence (`#n`, counted over the run), so multiplicity is kept and the sum is never collapsed.
- The amount, the KPI value and every `ignore` column are outside the key. A restated amount is therefore the same fact.

**Upsert on the natural key.** `natural_key` is a new column on `spend_fact` and `kpi_fact`, with a unique partial index on `(workspace_id, natural_key, period_date) WHERE natural_key IS NOT NULL`. The partition key has to be in it. A reloaded fact takes the new measure and the new run id, and is live again if it had been superseded. It keeps its envelope unless its tuple changed (a row id re-keyed upstream). If the tuple changed, the fact is unmatched and the run matches it again.

The same value is written to `source_row_hash`. That keeps the old unique constraint valid for new rows, so the previous worker and the new one can run side by side. Manual entry and demo data pass their existing deterministic hashes as the key.

**Two kinds of run** (`ingest_run.summary.mode`):

- **Full extract.** This covers CSV, Sheets, BigQuery without `updatedAtColumn`, the first run of an incremental source (including its first run after this change), and a requested full resync. The run is authoritative for its source over the dates it covers: `summary.coveredRange` is the min..max `period_date` of the rows it normalized, rejected rows included.
  - At the end, in the run's final transaction, every live fact of the source in that range that the run did not load or reload is **superseded**. The source of a fact is found through `source_run_id → ingest_run.source_id`.
  - Facts dated in a closed period the run may not restate are left alone.
  - An empty extract supersedes nothing.
- **Incremental.** Snowflake, and BigQuery with `updatedAtColumn`, after a run that already keyed its facts. The run reads rows updated since the previous run's start, minus a one-hour overlap (`SINCE_OVERLAP_MS`, I-30). Each row upserts by its row id, so re-reading is harmless.
  - A row whose date moved supersedes the same key on its old date.
  - An incremental run cannot see deletes. **Full resync** (`POST /sources/:id/run { fullResync: true }`, a button on the Sources page) runs the source once as a full extract.
  - An incremental source **must** map a `row_id`. Creating or changing one without it is a `VALIDATION` error. A source saved before this change fails its next run with `ingest.run.failed` and an `ingest.failed` event that say what to map.

**Superseding is soft and reversible.** The three fact tables gain `superseded_at timestamptz` and `superseded_by_run_id uuid`. Facts are never hard-deleted (AGENTS §4). Every reader filters `superseded_at IS NULL`:

- the planner, in both the Postgres and BigQuery dialects: `actual` edges, KPI facts, projected spend and its existence check;
- `spend_month_apply()`: an UPDATE that sets `superseded_at` subtracts like a DELETE, and one that clears it adds like an INSERT;
- roll-ups, pacing, closures and exports, because they read through the planner;
- the unmatched queue and mapping, run coverage, freshness (`dataAsOf`, `lastFactDate`), `actualsByEnvelope`, `spendThrough`, `hasProjections`, and the Overview's projection check;
- retention: `rows` counts every row, `amount` sums the live ones, the same on both sides.

`summary.superseded` counts what a run retired. The Sources page shows "N facts superseded". `facts.loaded` lists every envelope whose facts the run loaded, changed or superseded, so the roll-ups that are now stale get refreshed.

**BigQuery.** Datastream replicates `superseded_at` with the rest of each fact table. Every curated view, and every reader of a replica fact table, must add `superseded_at IS NULL`. `v_budget_vs_actual_daily`, the BigQuery planner dialect and the retention comparison already do.

**Expand/contract.** Migration `20261011000000_fact_identity` only adds: the columns, the natural-key and live-date indexes, and the trigger function. Existing facts keep `natural_key` NULL, because a full-extract source has no key to rebuild from. Each source's next run supersedes and reloads them; for an incremental source that run is a full extract by the rule above. A later PR drops the `UNIQUE (workspace_id, source_row_hash, period_date)` constraints, once no deployed worker writes facts without a natural key. The commands are in the migration header.

## Consequences

- A restated row updates its one fact. A row missing from a full re-extract stops counting everywhere at the end of that run, and comes back if a later run delivers it again.
- **Rejected rows count as missing.** A rerun that rejects a row it used to accept, for example because of a missing FX rate, a retired value or a mapping change, supersedes that row's old fact. The run's reject report and `superseded` count show it. Fix and re-run to restore it.
- **The covered range is the extract's own dates.** If every row on the first or last date of a source disappears, those dates are outside the next range and are not reconciled. A source's later extracts normally cover them again.
- **Reconciliation and the source.** A CSV source that is pointed at a new file of a different period supersedes nothing outside that file's dates. One that is pointed at a corrected file of the same period replaces it.
- While a run is loading, its batches commit before the final supersession. Until the run finishes, a reload of facts that predate this change can briefly show both the old and the new rows. Partial-run visibility in general is I-12, handled in W3-4.
- If the same row id arrives twice in one batch, the last one wins. If it arrives on two dates in one run, both stay until the next run.
- FX still takes the latest rate of any age (the second half of I-30). That needs a product decision on a maximum age.

## Addendum (W4-1, 2026-10-06): AGENTS §4's money rule now holds for projections (audit T-4)

`projection_fact` was the one fact table where AGENTS §4 ("every amount carries currency; converted amounts carry fx_rate_id") did not hold: it had neither column, and the pipeline copied a money projection's raw `value` straight into `value_reporting`, so a feed in a non-reporting currency showed its projected close, variance and the pacing rules' `projected_close_pct` / `projected_variance_abs` unconverted (roughly the feed's FX rate too high or too low).

This ADR is the right place for the addendum, not ADR-030: ADR-030 is a planner query-shape decision (how `projected` is computed efficiently), not the fact's own representation; this ADR already owns money-on-facts conventions (`natural_key`/`superseded_at`, "never the measure") alongside AGENTS §4.

- **Currency resolution**, for the projection role mapped with `metric: "spend"` (the default; any other metric is not money and is never converted): a `currency` role column if the mapping has one, else an inline `currency` on the projection role (new, optional, mirrors the `amount` role's), else the workspace's `reporting_currency`. Unlike spend, a projection with no mapped currency is **not rejected** — it falls back to the workspace's reporting currency, because a projection is a secondary, derived signal (spec §6.2's "latest run" semantics), not the actuals of record. Which of the three resolved it is recorded once per run in `summary.projectionCurrency` (`"column" | "constant" | "workspace_fallback"`), not in `match_method`, which stays the tuple-matching method ADR-071 already defined.
- **Conversion**: the same `FxCache` as spend facts, at the fact's own `period_date`, `ROUND_HALF_UP` to 2dp. A currency equal to the reporting currency gets `fx_rate_id = NULL` (the identity case, same as spend). A missing rate rejects the row with the same reason spend uses (`no FX rate <ccy>→<reporting> on <date>`); the row counts in `rowsRejected` and the reject report, same as any other rejected row, and — because projections are snapshots with no natural key (one `INSERT` per run, never an upsert) — there is nothing to supersede.
- **Migration** `20261012000000_projection_fact_currency` adds `currency char(3) NULL` and `fx_rate_id uuid NULL` to `projection_fact` (expand-only, catalog-only on the partitioned parent) and backfills `currency` on existing rows from `workspace.reporting_currency`, since those rows were always written as if already in the reporting currency. `fx_rate_id` stays NULL for them. `projection_fact` is hand-written SQL, not a Prisma model (like `spend_fact`/`kpi_fact`), so there is no `schema.prisma` change.
- **Readers already use `value_reporting`** (the query planner, both dialects; nothing reads `value` for money), so no reader changed. No BigQuery view references `projection_fact` today, so there was no curated view to extend.
