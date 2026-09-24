import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChromePath } from "../../../scripts/chrome-path.mjs";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function only(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path);
}

describe("resolveChromePath", () => {
  it("prefers CHROME_PATH over platform defaults", () => {
    expect(resolveChromePath({ CHROME_PATH: "/opt/chrome" }, "darwin", only("/opt/chrome", MAC_CHROME))).toBe("/opt/chrome");
  });

  it("fails loudly when CHROME_PATH does not exist", () => {
    expect(() => resolveChromePath({ CHROME_PATH: "/nope" }, "linux", only())).toThrow(/CHROME_PATH/);
  });

  it("finds the Chrome app bundle on macOS", () => {
    expect(resolveChromePath({}, "darwin", only(MAC_CHROME))).toBe(MAC_CHROME);
  });

  it("searches PATH for google-chrome, then chromium, on Linux", () => {
    const env = { PATH: "/usr/local/bin:/usr/bin" };
    expect(resolveChromePath(env, "linux", only(join("/usr/bin", "chromium")))).toBe(join("/usr/bin", "chromium"));
    expect(resolveChromePath(env, "linux", only(join("/usr/bin", "chromium"), join("/usr/bin", "google-chrome")))).toBe(
      join("/usr/bin", "google-chrome"),
    );
  });

  it("names CHROME_PATH when nothing is found", () => {
    expect(() => resolveChromePath({ PATH: "/usr/bin" }, "linux", only())).toThrow(/set CHROME_PATH/);
  });
});
