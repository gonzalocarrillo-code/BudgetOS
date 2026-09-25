import { describe, expect, it } from "vitest";
import { CloseInput, fiscalPeriodKind } from "./index.js";

describe("CloseInput", () => {
  it("takes exactly one of periodId or periodKey, and only resolvable keys", () => {
    expect(CloseInput.safeParse({ periodKey: "2026-Q1" }).success).toBe(true);
    expect(CloseInput.safeParse({}).success).toBe(false);
    expect(CloseInput.safeParse({ periodKey: "2026-Q1", periodId: "01927a00-0000-7000-8000-0000000000c1" }).success).toBe(false);
    expect(CloseInput.safeParse({ periodKey: "2026-Q5" }).success).toBe(false);
    expect(["FY2026", "2026-Q3", "2026-11"].map(fiscalPeriodKind)).toEqual(["year", "quarter", "month"]);
  });
});
