import { expect, it } from "vitest";
import { csvCell } from "./csv.js";

it("returns empty string for null and undefined", () => {
  expect(csvCell(null)).toBe("");
  expect(csvCell(undefined)).toBe("");
});

it("prefixes dangerous formula characters (except plain numbers)", () => {
  // Formula characters without special CSV chars (no quoting needed)
  expect(csvCell("=LINK")).toBe("'=LINK");
  expect(csvCell("@SUM")).toBe("'@SUM");
  // Plain numbers: NOT prefixed (they're safe)
  expect(csvCell("-12.50")).toBe("-12.50");
  expect(csvCell("+34")).toBe("+34");
  // Non-plain numbers with special chars: prefixed AND quoted
  expect(csvCell("-1,000")).toBe("\"'-1,000\"");
  expect(csvCell("=1+2")).toBe("'=1+2");
  // Tab (prefix only, no quoting needed)
  expect(csvCell("\ttab")).toBe("'\ttab");
  // Carriage return (prefix AND quote because \r is in quoting regex)
  expect(csvCell("\rcarriage")).toBe("\"'\rcarriage\"");
  // Formula character with double quote (both prefix + quoting applied)
  expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\""
);
});

it("quotes cells with special characters", () => {
  expect(csvCell('test "quoted" text')).toBe('"test ""quoted"" text"');
  expect(csvCell("text,with,commas")).toBe('"text,with,commas"');
  expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  expect(csvCell("carriage\rreturn")).toBe('"carriage\rreturn"');
});

it("handles formula prefix + quoting together", () => {
  expect(csvCell('=LINK("http://test"),other')).toBe('"\'=LINK(""http://test""),other"');
});

it("handles plain text without special chars", () => {
  expect(csvCell("plain text")).toBe("plain text");
  expect(csvCell("123")).toBe("123");
});

it("handles numbers as strings", () => {
  expect(csvCell(123)).toBe("123");
  expect(csvCell(123.45)).toBe("123.45");
});
