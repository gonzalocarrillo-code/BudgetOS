import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@budget/domain";

/**
 * Slack request signing (api.slack.com/authentication/verifying-requests-from-slack):
 * `v0=` HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's signing secret, and a timestamp
 * within five minutes (replays are refused). Without a secret, Slack routes refuse everything.
 */
export function verifySlackSignature(args: { rawBody: string | undefined; timestamp: string | undefined; signature: string | undefined; secret: string | undefined; now?: number }): void {
  if (!args.secret) throw new DomainError("FORBIDDEN", "Slack is not connected (no signing secret)");
  if (args.rawBody === undefined || !args.timestamp || !args.signature) throw new DomainError("FORBIDDEN", "Not a signed Slack request");
  const ts = Number(args.timestamp);
  const now = Math.floor((args.now ?? Date.now()) / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) throw new DomainError("FORBIDDEN", "Slack request is too old");
  const expected = `v0=${createHmac("sha256", args.secret).update(`v0:${args.timestamp}:${args.rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(args.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError("FORBIDDEN", "Bad Slack signature");
}

/** Signs a body as Slack would (tests, local tools). */
export function signSlackBody(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): { "x-slack-request-timestamp": string; "x-slack-signature": string } {
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}` };
}
