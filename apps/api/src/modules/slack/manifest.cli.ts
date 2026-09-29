import { apiUrl } from "./slack-config.js";
import { slackManifest } from "./manifest.js";

/**
 * `pnpm slack:manifest [--url https://<api host>]`: the Slack app manifest for that API (default
 * API_PUBLIC_URL), to paste at api.slack.com/apps when creating the app or when its URL changes.
 */
const at = process.argv.indexOf("--url");
const url = at === -1 ? apiUrl() : process.argv[at + 1];
if (url === undefined || !/^https:\/\/[^/\s]+/.test(url)) {
  process.stderr.write("usage: pnpm slack:manifest --url https://<the API's public host>\n");
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(slackManifest(url), null, 2)}\n`);
