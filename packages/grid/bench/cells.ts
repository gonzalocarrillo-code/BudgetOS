import { GridCellKind, type TextCell } from "@glideapps/glide-data-grid";
import {
  createColumnHelper,
  createTable,
  getCoreRowModel,
  type Table,
  type TableState,
} from "@tanstack/table-core";
import { defaultRangeExtractor } from "@tanstack/virtual-core";
import {
  SPIKE_COLUMNS,
  SPIKE_COLUMN_COUNT,
  SPIKE_OVERSCAN,
  SPIKE_ROW_COUNT,
  SPIKE_VISIBLE_ROWS,
  materializeRows,
  type SpikeColumn,
  type SpikeRow,
} from "./rows.js";

const helper = createColumnHelper<SpikeRow>();

const spikeColumns = SPIKE_COLUMNS.map((key) =>
  helper.accessor(key, {
    id: key,
    header: key,
  }),
);

export interface CellPathNumbers {
  cpuScaleMs: number;
  glideVisibleWindowP50Ms: number;
  tanstackVisibleWindowP50Ms: number;
  glideGetCellMedianMs: number;
  tanstackGetCellMedianMs: number;
  glideModelBuildMs: number;
  tanstackModelBuildMs: number;
}

export function glideCell(row: SpikeRow, column: SpikeColumn): TextCell {
  const value = row[column];
  return {
    kind: GridCellKind.Text,
    data: value,
    displayData: value,
    allowOverlay: false,
    copyData: value,
  };
}

export function visibleIndexes(start: number): number[] {
  return defaultRangeExtractor({
    startIndex: start,
    endIndex: start + SPIKE_VISIBLE_ROWS - 1,
    overscan: SPIKE_OVERSCAN,
    count: SPIKE_ROW_COUNT,
  });
}

const spikeState: TableState = {
  columnFilters: [],
  columnOrder: [],
  columnPinning: { left: [], right: [] },
  columnSizing: {},
  columnSizingInfo: {
    columnSizingStart: [],
    deltaOffset: null,
    deltaPercentage: null,
    isResizingColumn: false,
    startOffset: null,
    startSize: null,
  },
  columnVisibility: {},
  expanded: {},
  globalFilter: undefined,
  grouping: [],
  pagination: { pageIndex: 0, pageSize: SPIKE_ROW_COUNT },
  rowPinning: { top: [], bottom: [] },
  rowSelection: {},
  sorting: [],
};

export function createSpikeTable(data: SpikeRow[]): Table<SpikeRow> {
  return createTable({
    data,
    columns: spikeColumns,
    getCoreRowModel: getCoreRowModel(),
    state: spikeState,
    onStateChange: () => undefined,
    renderFallbackValue: null,
  });
}

function readGlideWindow(rows: SpikeRow[], start: number): number {
  let sink = 0;
  for (const index of visibleIndexes(start)) {
    const row = rows[index];
    if (row === undefined) {
      throw new Error(`missing spike row ${index}`);
    }
    for (const column of SPIKE_COLUMNS) {
      sink += glideCell(row, column).displayData.length;
    }
  }
  return sink;
}

function readTanstackWindow(table: Table<SpikeRow>, start: number): number {
  const model = table.getRowModel().rows;
  let sink = 0;
  for (const index of visibleIndexes(start)) {
    const row = model[index];
    if (row === undefined) {
      throw new Error(`missing table row ${index}`);
    }
    for (const cell of row.getVisibleCells()) {
      sink += String(cell.getValue()).length;
    }
  }
  return sink;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const mid = sorted[Math.floor(sorted.length / 2)];
  if (mid === undefined) {
    throw new Error("bench produced no samples");
  }
  return mid;
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

function windowP50(read: (start: number) => number): number {
  let sink = 0;
  for (let n = 0; n < 40; n += 1) {
    sink += read(n * SPIKE_VISIBLE_ROWS);
  }
  const samples: number[] = [];
  for (let batch = 0; batch < 15; batch += 1) {
    const start = performance.now();
    for (let n = 0; n < 80; n += 1) {
      const offset = ((batch * 80 + n) * SPIKE_VISIBLE_ROWS) % (SPIKE_ROW_COUNT - SPIKE_VISIBLE_ROWS);
      sink += read(offset);
    }
    samples.push(performance.now() - start);
  }
  if (sink <= 0) {
    throw new Error("window bench did not read cells");
  }
  return median(samples);
}

const CELL_ROWS_PER_SAMPLE = 8_000;

function cellMedian(readRow: (index: number) => number): number {
  let sink = 0;
  for (let n = 0; n < 100; n += 1) {
    sink += readRow(n);
  }
  const samples: number[] = [];
  for (let sample = 0; sample < 21; sample += 1) {
    const start = process.hrtime.bigint();
    for (let n = 0; n < CELL_ROWS_PER_SAMPLE; n += 1) {
      sink += readRow(sample * CELL_ROWS_PER_SAMPLE + n);
    }
    samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
  }
  if (sink <= 0) {
    throw new Error("cell bench did not read a cell");
  }
  return median(samples);
}

function cpuScale(): number {
  const samples: number[] = [];
  let sink = 0;
  for (let sample = 0; sample < 5; sample += 1) {
    const start = performance.now();
    for (let n = 0; n < 4_000_000; n += 1) {
      sink = (sink + n) % 997;
    }
    samples.push(performance.now() - start);
  }
  if (sink < 0) {
    throw new Error("cpu calibration did not run");
  }
  const scale = median(samples);
  if (scale <= 0) {
    throw new Error("cpu calibration was empty");
  }
  return scale;
}

export function measureCellPath(): CellPathNumbers {
  const scale = cpuScale();
  const rows = materializeRows();
  if (rows.length !== SPIKE_ROW_COUNT || SPIKE_COLUMN_COUNT !== 12) {
    throw new Error("spike fixture is not 100k rows by 12 columns");
  }

  const glideBuilds: number[] = [];
  for (let n = 0; n < 3; n += 1) {
    const start = performance.now();
    let sink = 0;
    for (let repeat = 0; repeat < 100; repeat += 1) {
      sink += readGlideWindow(rows, 0);
    }
    glideBuilds.push(performance.now() - start);
    if (sink <= 0) {
      throw new Error("glide model build did not read cells");
    }
  }

  const tanstackBuilds: number[] = [];
  let table: Table<SpikeRow> | undefined;
  for (let n = 0; n < 3; n += 1) {
    table = undefined;
    const start = performance.now();
    const built = createSpikeTable(rows);
    const count = built.getRowModel().rows.length;
    tanstackBuilds.push(performance.now() - start);
    table = built;
    if (count !== SPIKE_ROW_COUNT) {
      throw new Error(`tanstack row model has ${count} rows`);
    }
  }
  if (table === undefined) {
    throw new Error("tanstack model was not built");
  }

  const glideVisibleWindowP50Ms = windowP50((start) => readGlideWindow(rows, start));
  const tanstackVisibleWindowP50Ms = windowP50((start) => readTanstackWindow(table, start));

  const glideGetCellMedianMs = cellMedian((index) => {
    const row = rows[index % SPIKE_ROW_COUNT];
    if (row === undefined) {
      throw new Error("missing glide cell row");
    }
    let length = 0;
    for (const column of SPIKE_COLUMNS) {
      length += glideCell(row, column).displayData.length;
    }
    return length;
  });

  const model = table.getRowModel().rows;
  const tanstackGetCellMedianMs = cellMedian((index) => {
    const row = model[index % SPIKE_ROW_COUNT];
    if (row === undefined) {
      throw new Error("missing tanstack cell row");
    }
    let length = 0;
    for (const cell of row.getVisibleCells()) {
      length += String(cell.getValue()).length;
    }
    return length;
  });

  return {
    cpuScaleMs: roundMs(scale),
    glideVisibleWindowP50Ms: roundMs(glideVisibleWindowP50Ms),
    tanstackVisibleWindowP50Ms: roundMs(tanstackVisibleWindowP50Ms),
    glideGetCellMedianMs: roundMs(glideGetCellMedianMs),
    tanstackGetCellMedianMs: roundMs(tanstackGetCellMedianMs),
    glideModelBuildMs: roundMs(median(glideBuilds)),
    tanstackModelBuildMs: roundMs(median(tanstackBuilds)),
  };
}
