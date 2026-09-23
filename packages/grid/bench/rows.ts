export const SPIKE_ROW_COUNT = 100_000;

export const SPIKE_COLUMNS = [
  "path",
  "budget",
  "actual",
  "projected",
  "varianceAbs",
  "variancePct",
  "remaining",
  "paceIndex",
  "target",
  "status",
  "chips",
  "dimension",
] as const;

export type SpikeColumn = (typeof SPIKE_COLUMNS)[number];

export interface SpikeRow {
  path: string;
  budget: string;
  actual: string;
  projected: string;
  varianceAbs: string;
  variancePct: string;
  remaining: string;
  paceIndex: string;
  target: string;
  status: string;
  chips: string;
  dimension: string;
}

export const SPIKE_COLUMN_COUNT = SPIKE_COLUMNS.length;
export const SPIKE_ROW_HEIGHT = 36;
export const SPIKE_VISIBLE_ROWS = 32;
export const SPIKE_OVERSCAN = 5;

export function spikeRow(index: number): SpikeRow {
  const n = index + 1;
  return {
    path: `region-${n % 8}/envelope-${n}`,
    budget: (1000 + (n % 5000)).toFixed(2),
    actual: (800 + (n % 4000)).toFixed(2),
    projected: (900 + (n % 4500)).toFixed(2),
    varianceAbs: (n % 200).toFixed(2),
    variancePct: ((n % 100) / 100).toFixed(2),
    remaining: (200 + (n % 1000)).toFixed(2),
    paceIndex: ((n % 150) / 100).toFixed(2),
    target: (50 + (n % 80)).toFixed(2),
    status: n % 5 === 0 ? "pending" : "approved",
    chips: String(n % 4),
    dimension: `country-${n % 40}`,
  };
}

export function materializeRows(): SpikeRow[] {
  const rows = new Array<SpikeRow>(SPIKE_ROW_COUNT);
  for (let index = 0; index < SPIKE_ROW_COUNT; index += 1) {
    rows[index] = spikeRow(index);
  }
  return rows;
}
