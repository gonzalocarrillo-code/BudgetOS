/**
 * W3-4 (audit I-9): the lease an ingest run or export job holds while `running`. The claim sets
 * `lease_until = now() + RUN_LEASE_MS`; the ingest pipeline refreshes it after each flush and the
 * export worker after writing its object. `runSweeper` (ingest/sweeper.ts) fails a `running` row
 * whose lease has expired — the worker that held it died without saying so.
 */
export const RUN_LEASE_MS = 20 * 60 * 1000;

export function leaseUntil(now: Date = new Date()): Date {
  return new Date(now.getTime() + RUN_LEASE_MS);
}
