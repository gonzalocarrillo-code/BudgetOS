import { describe, expect, it } from "vitest";
import { t } from "./i18n.js";

describe("t", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(t("search.results", { count: 3, q: "meta" })).toBe("3 results for “meta”");
    expect(t("page.pending", {})).toBe("This screen arrives with {task}.");
  });
});
