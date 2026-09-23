import { expect, it } from "vitest";
import { parseSearch, type ParsedSearch } from "./search.js";

// Twenty cases: the qualifier examples named for this parser (plan §11.3, consumed by spec §12.3)
// plus the branches written in spec §12.2 (free text, empty input, negation, quotes, case fold,
// and the combined example from the search tool description).
const cases: Array<{ input: string; expected: ParsedSearch }> = [
  { input: "type:envelope", expected: { text: "", qualifiers: [], types: ["envelope"] } },
  {
    input: "country:BR",
    expected: { text: "", qualifiers: [{ key: "country", op: "eq", value: "BR" }], types: [] },
  },
  {
    input: "platform:meta",
    expected: { text: "", qualifiers: [{ key: "platform", op: "eq", value: "meta" }], types: [] },
  },
  {
    input: "objective:non_brand",
    expected: { text: "", qualifiers: [{ key: "objective", op: "eq", value: "non_brand" }], types: [] },
  },
  {
    input: "status:pending",
    expected: { text: "", qualifiers: [{ key: "status", op: "eq", value: "pending" }], types: [] },
  },
  {
    input: "owner:@me",
    expected: { text: "", qualifiers: [{ key: "owner", op: "eq", value: "@me" }], types: [] },
  },
  {
    input: "approver:@me",
    expected: { text: "", qualifiers: [{ key: "approver", op: "eq", value: "@me" }], types: [] },
  },
  {
    input: "tag:black-friday",
    expected: { text: "", qualifiers: [{ key: "tag", op: "eq", value: "black-friday" }], types: [] },
  },
  {
    input: "period:2026-Q4",
    expected: { text: "", qualifiers: [{ key: "period", op: "eq", value: "2026-Q4" }], types: [] },
  },
  {
    input: "budget:>1000000",
    expected: { text: "", qualifiers: [{ key: "budget", op: "gt", value: "1000000" }], types: [] },
  },
  {
    input: "cpa:>target",
    expected: { text: "", qualifiers: [{ key: "cpa", op: "gt", value: "target" }], types: [] },
  },
  {
    input: "has:open-thread",
    expected: { text: "", qualifiers: [{ key: "has", op: "eq", value: "open-thread" }], types: [] },
  },
  {
    input: "mentions:@me",
    expected: { text: "", qualifiers: [{ key: "mentions", op: "eq", value: "@me" }], types: [] },
  },
  {
    input: "updated:<7d",
    expected: { text: "", qualifiers: [{ key: "updated", op: "lt", value: "7d" }], types: [] },
  },
  {
    input: "brazil meta country:BR status:pending",
    expected: {
      text: "brazil meta",
      qualifiers: [
        { key: "country", op: "eq", value: "BR" },
        { key: "status", op: "eq", value: "pending" },
      ],
      types: [],
    },
  },
  { input: "", expected: { text: "", qualifiers: [], types: [] } },
  { input: "brazil meta", expected: { text: "brazil meta", qualifiers: [], types: [] } },
  {
    input: "-status:pending",
    expected: { text: "", qualifiers: [{ key: "status", op: "neq", value: "pending" }], types: [] },
  },
  {
    input: 'status:"pending review"',
    expected: { text: "", qualifiers: [{ key: "status", op: "eq", value: "pending review" }], types: [] },
  },
  { input: "TYPE:Envelope", expected: { text: "", qualifiers: [], types: ["envelope"] } },
];

it("parseSearch covers 20 spec cases", () => {
  expect(cases).toHaveLength(20);
  for (const entry of cases) {
    expect(parseSearch(entry.input), entry.input).toEqual(entry.expected);
  }
});
