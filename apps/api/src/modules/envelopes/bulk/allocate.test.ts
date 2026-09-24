import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { allocate, largestRemainder, rephase } from "./allocate.js";
import { MemoryPreviewStore } from "./preview-store.js";
import { parseCsv, toCsv } from "./csv.js";

const d = (v: string | number) => new Decimal(v);
const sum = (xs: Decimal[]) => xs.reduce((s, x) => s.plus(x), d(0)).toFixed(2);
const rows = (...amounts: Array<string | null>) => amounts.map((a, i) => ({ envelopeId: `00000000-0000-7000-8000-00000000000${i}`, currency: "USD", before: a === null ? null : d(a) }));

describe("largestRemainder", () => {
  it("sums to the total to the cent, whatever the weights", () => {
    expect(sum(largestRemainder(d("100.00"), [d(1), d(1), d(1)]))).toBe("100.00");
    expect(largestRemainder(d("100.00"), [d(1), d(1), d(1)]).map((x) => x.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
    expect(sum(largestRemainder(d("-10.01"), [d(3), d(1)]))).toBe("-10.01");
    expect(largestRemainder(d("5.00"), [d(0), d(0)]).map((x) => x.toFixed(2))).toEqual(["2.50", "2.50"]); // all-zero weights → even
    expect(() => largestRemainder(d(1), [d(-1)])).toThrow(/negative/);
  });
  it("is exact for many rows (no drift)", () => {
    const w = Array.from({ length: 997 }, (_, i) => d((i % 7) + 1));
    expect(sum(largestRemainder(d("123456.78"), w))).toBe("123456.78");
  });
});

describe("rephase", () => {
  it("keeps the monthly shape and sums exactly", () => {
    const shape = [
      { month: "2026-10-01", amount: d("100.00") },
      { month: "2026-11-01", amount: d("300.00") },
    ];
    const out = rephase(shape, d("1000.01"));
    expect(out.map((p) => p.amount.toFixed(2))).toEqual(["250.00", "750.01"]);
  });
});

describe("allocate", () => {
  it("set / add / pct", () => {
    const r = rows("100.00", "200.00", null);
    expect([...allocate(r, { op: "set", amount: "5" }).after.values()].map((x) => x.toFixed(2))).toEqual(["5.00", "5.00", "5.00"]);
    expect([...allocate(r, { op: "add", amount: "-10.50" }).after.values()].map((x) => x.toFixed(2))).toEqual(["89.50", "189.50", "-10.50"]);
    expect([...allocate(r, { op: "pct", pct: 15 }).after.values()].map((x) => x.toFixed(2))).toEqual(["115.00", "230.00", "0.00"]);
    expect([...allocate(rows("0.05"), { op: "pct", pct: 50 }).after.values()][0]?.toFixed(2)).toBe("0.08"); // half up
  });
  it("scale_to_total keeps proportions and hits the total", () => {
    const out = [...allocate(rows("1.00", "2.00", "3.00"), { op: "scale_to_total", total: "100.00" }).after.values()];
    expect(out.map((x) => x.toFixed(2))).toEqual(["16.67", "33.33", "50.00"]);
  });
  it("redistribute: proportional, even, by weights, by actuals, from the parent's amount", () => {
    const r = rows("100.00", "300.00");
    const ctx = { parentAmount: d("1000.00"), parentCurrency: "USD" };
    const pid = "00000000-0000-7000-8000-0000000000ff";
    expect([...allocate(r, { op: "redistribute", parentId: pid, method: "proportional" }, ctx).after.values()].map((x) => x.toFixed(2))).toEqual(["250.00", "750.00"]);
    expect([...allocate(r, { op: "redistribute", parentId: pid, method: "even", total: "9.99" }, ctx).after.values()].map((x) => x.toFixed(2))).toEqual(["5.00", "4.99"]);
    const weights = { [r[0]!.envelopeId]: 1, [r[1]!.envelopeId]: 4 };
    expect([...allocate(r, { op: "redistribute", parentId: pid, method: "by_weights", weights }, ctx).after.values()].map((x) => x.toFixed(2))).toEqual(["200.00", "800.00"]);
    expect(() => allocate(r, { op: "redistribute", parentId: pid, method: "by_weights", weights: {} }, ctx)).toThrow(/Weights missing/);
    expect(() => allocate(r, { op: "redistribute", parentId: pid, method: "by_last_actuals" }, { ...ctx, actuals: new Map() })).toThrow(/No actuals/);
    const actuals = new Map([[r[0]!.envelopeId, d(3)], [r[1]!.envelopeId, d(1)]]);
    expect([...allocate(r, { op: "redistribute", parentId: pid, method: "by_last_actuals" }, { ...ctx, actuals }).after.values()].map((x) => x.toFixed(2))).toEqual(["750.00", "250.00"]);
    expect(() => allocate(r, { op: "redistribute", parentId: pid, method: "even" }, { parentAmount: null })).toThrow(/no approved amount/);
  });
  it("copy_previous_period skips rows without a usable previous period, with the reason", () => {
    const r = rows("1.00", "2.00", "3.00");
    const previous = new Map([
      [r[0]!.envelopeId, { amount: d("40.00"), currency: "USD" }],
      [r[1]!.envelopeId, { amount: d("40.00"), currency: "EUR" }],
    ]);
    const out = allocate(r, { op: "copy_previous_period", factor: 1.1 }, { previous });
    expect(out.after.get(r[0]!.envelopeId)?.toFixed(2)).toBe("44.00");
    expect(out.skipped.map((s) => s.reason)).toEqual(["previous period is in EUR", "no approved previous period with the same dimensions"]);
  });
  it("mixed currencies are refused where a total is shared", () => {
    const r = [...rows("1.00"), { envelopeId: "00000000-0000-7000-8000-0000000000aa", currency: "EUR", before: d(1) }];
    expect(() => allocate(r, { op: "scale_to_total", total: "10" })).toThrow(/one currency/);
  });
  it("paste takes explicit amounts and refuses duplicates", () => {
    const r = rows("1.00", "2.00");
    const out = allocate(r, { op: "paste", rows: [{ envelopeId: r[1]!.envelopeId, amount: "7.77" }] });
    expect([...out.after.entries()]).toEqual([[r[1]!.envelopeId, d("7.77")]]);
    expect(() => allocate(r, { op: "paste", rows: [{ envelopeId: r[0]!.envelopeId, amount: "1" }, { envelopeId: r[0]!.envelopeId, amount: "2" }] })).toThrow(/twice/);
  });
});

describe("csv", () => {
  it("round-trips quotes, commas and newlines", () => {
    const text = toCsv(["a", "b"], [["1", 'He said "hi", twice'], ["2", "line\nbreak"]]);
    expect(parseCsv(text)).toEqual([["a", "b"], ["1", 'He said "hi", twice'], ["2", "line\nbreak"]]);
    expect(parseCsv("x,y\r\n1,2\r\n\r\n")).toEqual([["x", "y"], ["1", "2"]]);
  });
});

describe("MemoryPreviewStore", () => {
  it("expires after the TTL", async () => {
    let now = 0;
    const s = new MemoryPreviewStore(() => now);
    await s.put("p", "v", 60);
    expect(await s.get("p")).toBe("v");
    now = 60_000;
    expect(await s.get("p")).toBeNull();
  });
});
