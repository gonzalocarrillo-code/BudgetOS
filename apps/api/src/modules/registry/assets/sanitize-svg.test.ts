import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "./sanitize-svg.js";

/**
 * Sanitizing an icon must not change how the rest of the API talks HTTP: jsdom 30 installs undici 8
 * as the global dispatcher, which left Slack's gzip replies undecoded in this process.
 */
describe("sanitizeSvg", () => {
  const DISPATCHER = Symbol.for("undici.globalDispatcher.1");

  it("keeps a clean icon and leaves the global HTTP dispatcher as it was", async () => {
    const g = globalThis as Record<symbol, unknown>;
    const before = g[DISPATCHER];
    const clean = await sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" onclick="x()"/><script>x()</script></svg>');
    expect(clean).toContain("<svg");
    expect(clean).not.toMatch(/script|onclick/i);
    expect(g[DISPATCHER]).toBe(before);
  });

  it("still refuses what is not an SVG", async () => {
    await expect(sanitizeSvg("<html></html>")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
