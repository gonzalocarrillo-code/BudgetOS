import {
  GridCellKind,
  getMiddleCenterBias,
  measureTextCached,
  type CustomCell,
  type CustomRenderer,
  type GridCell,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import type { DrawArgs } from "@glideapps/glide-data-grid";
import { Decimal } from "decimal.js";
import type { QueryRow } from "@budget/domain";
import {
  DateEditor,
  DimensionPicker,
  MoneyEditor,
  PercentEditor,
  TagPicker,
  TextEditor,
} from "./editor-fields.js";
import { formatMoney } from "./editors.js";
import type { ColumnSpec } from "./types.js";

export type BudgetCell = GridCell & {
  readonly copyData: string;
  readonly accessibilityString: string;
};

interface PathCellData {
  kind: "path";
  level: number;
  name: string;
  hasChildren: boolean;
  expanded: boolean;
  chips: { pending: number; alerts: number; threads: number };
}

interface MoneyCellData {
  kind: "money";
  value: string | null;
  currency: string;
  display: string;
  editable: boolean;
}

interface PaceCellData {
  kind: "pace";
  value: string | null;
  ratio: number | null;
}

interface TargetCellData {
  kind: "target";
  metric: string;
  field: "target" | "actual" | "vsTargetPct";
  value: string | null;
  display: string;
  editable: boolean;
  currency: string;
}

interface StatusCellData {
  kind: "status";
  status: string;
  pending: number;
}

interface ChipsCellData {
  kind: "chips";
  pending: number;
  alerts: number;
  threads: number;
}

interface ChoiceCellData {
  kind: "dimension" | "date" | "tag" | "text";
  value: string | null;
  display: string;
  editable: boolean;
  dimensionKey?: string;
}

type DrawTheme = DrawArgs<GridCell>["theme"];

type PathCell = CustomCell<PathCellData> & BudgetCell;
type MoneyCell = CustomCell<MoneyCellData> & BudgetCell;
type PaceCell = CustomCell<PaceCellData> & BudgetCell;
type TargetCell = CustomCell<TargetCellData> & BudgetCell;
type StatusCell = CustomCell<StatusCellData> & BudgetCell;
type ChipsCell = CustomCell<ChipsCellData> & BudgetCell;
type ChoiceCell = CustomCell<ChoiceCellData> & BudgetCell;

interface TreeFlags {
  hasChildren: boolean;
  expanded: boolean;
  level?: number;
  name?: string;
}

function treeOf(row: QueryRow): TreeFlags {
  const extra = row as QueryRow & { hasChildren?: unknown; expanded?: unknown; level?: unknown; name?: unknown };
  const flags: TreeFlags = {
    hasChildren: extra.hasChildren === true,
    expanded: extra.expanded === true,
  };
  if (typeof extra.level === "number") flags.level = extra.level;
  if (typeof extra.name === "string") flags.name = extra.name;
  return flags;
}

function rowLevel(row: QueryRow, tree: TreeFlags): number {
  if (tree.level !== undefined) return tree.level;
  if (row.depth !== undefined) return row.depth;
  return Math.max(0, row.path.length - 1);
}

function announce(row: QueryRow, detail: string): string {
  const amount = row.measures["budget"] ?? "";
  const status = row.status ?? "";
  return `${row.path.join(" / ")} ${detail} ${amount} ${status}`.trim();
}

function kindOf(cell: CustomCell): string | undefined {
  if (typeof cell.data !== "object" || cell.data === null || !("kind" in cell.data)) return undefined;
  return typeof cell.data.kind === "string" ? cell.data.kind : undefined;
}

function drawText(
  ctx: CanvasRenderingContext2D,
  theme: DrawTheme,
  rect: Rectangle,
  text: string,
  align: "left" | "right",
  offsetX = 0,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.font = theme.baseFontFull;
  ctx.fillStyle = theme.textDark;
  const bias = getMiddleCenterBias(ctx, theme);
  const y = rect.y + rect.height / 2 + bias;
  if (align === "right") {
    const width = measureTextCached(text, ctx, theme.baseFontFull).width;
    ctx.fillText(text, rect.x + rect.width - theme.cellHorizontalPadding - width, y);
  } else {
    ctx.fillText(text, rect.x + theme.cellHorizontalPadding + offsetX, y);
  }
  ctx.restore();
}

function moneyDisplay(value: string | null, currency: string): string {
  if (value === null || value.length === 0) return "";
  return formatMoney(value, currency);
}

function ratioOf(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  try {
    const ratio = new Decimal(value).toNumber();
    return Number.isFinite(ratio) ? ratio : null;
  } catch {
    return null;
  }
}

export const pathCellRenderer: CustomRenderer<PathCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is PathCell => kindOf(cell) === "path",
  draw: (args, cell) => {
    const { ctx, theme, rect } = args;
    const marker = cell.data.hasChildren ? (cell.data.expanded ? "▾" : "▸") : "";
    const label = marker.length > 0 ? `${marker} ${cell.data.name}` : cell.data.name;
    const pending = cell.data.chips.pending > 0 ? ` ${cell.data.chips.pending}` : "";
    drawText(ctx, theme, rect, `${label}${pending}`, "left", cell.data.level * 16);
  },
};

export const moneyCellRenderer: CustomRenderer<MoneyCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is MoneyCell => kindOf(cell) === "money",
  draw: (args, cell) => {
    drawText(args.ctx, args.theme, args.rect, cell.data.display, "right");
  },
  provideEditor: (cell) => {
    if (!cell.data.editable) return undefined;
    return {
      disablePadding: true,
      editor: (props) => <MoneyEditor {...props} currency={cell.data.currency} />,
    };
  },
};

export const paceCellRenderer: CustomRenderer<PaceCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is PaceCell => kindOf(cell) === "pace",
  draw: (args, cell) => {
    const { ctx, theme, rect } = args;
    const barX = rect.x + theme.cellHorizontalPadding;
    const barWidth = Math.max(0, rect.width - theme.cellHorizontalPadding * 2);
    const barY = rect.y + rect.height / 2 - 3;
    ctx.save();
    ctx.fillStyle = theme.bgBubble;
    ctx.fillRect(barX, barY, barWidth, 6);
    const ratio = cell.data.ratio;
    if (ratio !== null && barWidth > 0) {
      const clamped = Math.min(Math.max(ratio, 0), 2);
      ctx.fillStyle = theme.accentColor;
      ctx.fillRect(barX, barY, (clamped / 2) * barWidth, 6);
      const tick = barX + barWidth / 2;
      ctx.fillStyle = theme.textDark;
      ctx.fillRect(tick, barY - 3, 1, 12);
    }
    ctx.restore();
    if (cell.data.value !== null) drawText(ctx, theme, rect, cell.data.value, "right");
  },
};

export const targetCellRenderer: CustomRenderer<TargetCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is TargetCell => kindOf(cell) === "target",
  draw: (args, cell) => {
    drawText(args.ctx, args.theme, args.rect, cell.data.display, "right");
  },
  provideEditor: (cell) => {
    if (!cell.data.editable) return undefined;
    if (cell.data.field === "vsTargetPct") {
      return { disablePadding: true, editor: (props) => <PercentEditor {...props} /> };
    }
    return {
      disablePadding: true,
      editor: (props) => <MoneyEditor {...props} currency={cell.data.currency} />,
    };
  },
};

export const statusCellRenderer: CustomRenderer<StatusCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is StatusCell => kindOf(cell) === "status",
  draw: (args, cell) => {
    const { ctx, theme, rect } = args;
    const text = cell.data.pending > 0 ? `${cell.data.status} ${cell.data.pending}` : cell.data.status;
    ctx.save();
    ctx.fillStyle = theme.bgBubble;
    ctx.fillRect(rect.x + 6, rect.y + 8, Math.min(rect.width - 12, 88), rect.height - 16);
    ctx.restore();
    drawText(ctx, theme, rect, text, "left");
  },
};

export const chipsCellRenderer: CustomRenderer<ChipsCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ChipsCell => kindOf(cell) === "chips",
  draw: (args, cell) => {
    const label = `${cell.data.pending} ${cell.data.alerts} ${cell.data.threads}`;
    drawText(args.ctx, args.theme, args.rect, label, "left");
  },
};

export const choiceCellRenderer: CustomRenderer<ChoiceCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is ChoiceCell => {
    const kind = kindOf(cell);
    return kind === "dimension" || kind === "date" || kind === "tag" || kind === "text";
  },
  draw: (args, cell) => {
    drawText(args.ctx, args.theme, args.rect, cell.data.display, "left");
  },
  provideEditor: (cell) => {
    if (!cell.data.editable) return undefined;
    if (cell.data.kind === "dimension") {
      const dimensionKey = cell.data.dimensionKey ?? "";
      return { disablePadding: true, editor: (props) => <DimensionPicker {...props} dimensionKey={dimensionKey} /> };
    }
    if (cell.data.kind === "date") return { disablePadding: true, editor: (props) => <DateEditor {...props} /> };
    if (cell.data.kind === "tag") return { disablePadding: true, editor: (props) => <TagPicker {...props} /> };
    return { disablePadding: true, editor: (props) => <TextEditor {...props} /> };
  },
};

export const customRenderers = [
  pathCellRenderer,
  moneyCellRenderer,
  paceCellRenderer,
  targetCellRenderer,
  statusCellRenderer,
  chipsCellRenderer,
  choiceCellRenderer,
];

export function buildCell(row: QueryRow, column: ColumnSpec, options: { currency: string }): BudgetCell {
  const tree = treeOf(row);
  switch (column.kind) {
    case "path": {
      const name = tree.name ?? row.path.at(-1) ?? "";
      const data: PathCellData = {
        kind: "path",
        level: rowLevel(row, tree),
        name,
        hasChildren: tree.hasChildren,
        expanded: tree.expanded,
        chips: { pending: row.pendingCount, alerts: row.openAlerts, threads: row.openThreads },
      };
      return {
        kind: GridCellKind.Custom,
        allowOverlay: false,
        copyData: name,
        data,
        accessibilityString: announce(row, name),
      };
    }
    case "measure": {
      const raw = row.measures[column.key] ?? null;
      if (column.key === "pace_index") {
        const data: PaceCellData = { kind: "pace", value: raw, ratio: ratioOf(raw) };
        return {
          kind: GridCellKind.Custom,
          allowOverlay: false,
          copyData: raw ?? "",
          data,
          accessibilityString: announce(row, raw ?? ""),
        };
      }
      const editable = column.editable === true;
      const data: MoneyCellData = {
        kind: "money",
        value: raw,
        currency: options.currency,
        display: moneyDisplay(raw, options.currency),
        editable,
      };
      return {
        kind: GridCellKind.Custom,
        allowOverlay: editable,
        copyData: raw ?? "",
        data,
        readonly: !editable,
        accessibilityString: announce(row, data.display),
      };
    }
    case "target": {
      const target = row.targets[column.metric];
      const raw = target?.[column.field] ?? null;
      const editable = column.editable === true;
      const display = column.field === "vsTargetPct" ? (raw === null ? "" : `${raw}%`) : moneyDisplay(raw, options.currency);
      const data: TargetCellData = {
        kind: "target",
        metric: column.metric,
        field: column.field,
        value: raw,
        display,
        editable,
        currency: options.currency,
      };
      return {
        kind: GridCellKind.Custom,
        allowOverlay: editable,
        copyData: raw ?? "",
        data,
        readonly: !editable,
        accessibilityString: announce(row, display),
      };
    }
    case "status": {
      const status = row.status ?? "";
      const data: StatusCellData = { kind: "status", status, pending: row.pendingCount };
      return {
        kind: GridCellKind.Custom,
        allowOverlay: false,
        copyData: status,
        data,
        accessibilityString: announce(row, status),
      };
    }
    case "chips": {
      const data: ChipsCellData = {
        kind: "chips",
        pending: row.pendingCount,
        alerts: row.openAlerts,
        threads: row.openThreads,
      };
      return {
        kind: GridCellKind.Custom,
        allowOverlay: false,
        copyData: "",
        data,
        accessibilityString: announce(row, `${data.pending} ${data.alerts} ${data.threads}`),
      };
    }
    case "dimension": {
      const value = row.dimensions[column.key] ?? "";
      if (column.editable === true) {
        const data: ChoiceCellData = {
          kind: "dimension",
          value,
          display: value,
          editable: true,
          dimensionKey: column.key,
        };
        return {
          kind: GridCellKind.Custom,
          allowOverlay: true,
          copyData: value,
          data,
          accessibilityString: announce(row, value),
        };
      }
      return {
        kind: GridCellKind.Text,
        allowOverlay: false,
        data: value,
        displayData: value,
        copyData: value,
        readonly: true,
        accessibilityString: announce(row, value),
      };
    }
  }
}
