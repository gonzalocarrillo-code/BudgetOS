import { useTheme } from "../../lib/theme.js";

/** The design tokens (packages/ui/src/tokens.css) as Glide theme values: the canvas cannot read CSS variables. */
export const GRID_THEME = {
  accentColor: "#1877f2",
  accentLight: "#f0f7ff",
  textDark: "#1b2638",
  textMedium: "#5b6b80",
  textLight: "#616f85",
  textHeader: "#5b6b80",
  bgCell: "#ffffff",
  bgHeader: "#fafbfc",
  bgHeaderHovered: "#f3f6fa",
  borderColor: "#e6eaf0",
  horizontalBorderColor: "#eef1f5",
  headerFontStyle: "600 13px",
  baseFontStyle: "13px",
  fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

/** UX-012: the dark tokens, for the canvas. */
export const GRID_THEME_DARK = {
  ...GRID_THEME,
  accentColor: "#5b9bff",
  accentLight: "#16233d",
  accentFg: "#0a1020",
  textDark: "#e6ebf2",
  textMedium: "#9aa7bb",
  textLight: "#8d9aae",
  textBubble: "#e6ebf2",
  textHeader: "#9aa7bb",
  textHeaderSelected: "#0a1020",
  bgCell: "#121a2b",
  bgCellMedium: "#151e31",
  bgHeader: "#0d1422",
  bgHeaderHasFocus: "#1a2438",
  bgHeaderHovered: "#1a2438",
  bgBubble: "#1a2438",
  bgBubbleSelected: "#243049",
  bgSearchResult: "#33270a",
  borderColor: "#243049",
  horizontalBorderColor: "#1c2740",
  drilldownBorder: "#3a4966",
  linkColor: "#93c5fd",
};

/** The grid theme for the current colour theme. */
export function useGridTheme(): typeof GRID_THEME {
  return useTheme().resolved === "dark" ? GRID_THEME_DARK : GRID_THEME;
}
