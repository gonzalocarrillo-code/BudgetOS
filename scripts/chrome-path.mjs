// Resolves the Chrome binary the grid and timeline benches drive over CDP.
// Plain ESM so both packages can import it by relative path without a new dependency.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import { delimiter, join } from "node:path";

const MAC_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
];

const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

const WINDOWS_SUFFIX = join("Google", "Chrome", "Application", "chrome.exe");

function candidates(env, platform) {
  if (platform === "darwin") {
    const roots = ["/Applications", join(homedir(), "Applications")];
    return roots.flatMap((root) => MAC_APPS.map((app) => join(root, app)));
  }
  if (platform === "win32") {
    return [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]
      .filter((root) => root !== undefined && root !== "")
      .map((root) => join(root, WINDOWS_SUFFIX));
  }
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  return LINUX_NAMES.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

export function resolveChromePath(env = process.env, platform = process.platform, exists = existsSync) {
  const override = env["CHROME_PATH"];
  if (override !== undefined && override !== "") {
    if (!exists(override)) {
      throw new Error(`CHROME_PATH points at ${override}, which does not exist`);
    }
    return override;
  }
  const tried = candidates(env, platform);
  const found = tried.find((path) => exists(path));
  if (found === undefined) {
    throw new Error(`Chrome not found for ${platform}; set CHROME_PATH. Tried: ${tried.join(", ")}`);
  }
  return found;
}
