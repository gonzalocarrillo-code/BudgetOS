import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@budget/domain";

/**
 * S-15: Slack's 300 s signature window alone lets a captured, validly-signed request (a button
 * click, a form submission) be replayed for as long as it is still inside that window — none of
 * `alert.snooze`, a decision or a form submit is idempotent. This is an in-memory cache of
 * `timestamp:signature` pairs already seen, per API process (budgetos-slack runs 1-2 instances: a
 * replay could in principle land on the other one). Swept lazily — no setInterval timer to leak —
 * at most once per window, which bounds it to one pass per 300 s regardless of traffic.
 */
const REPLAY_WINDOW_MS = 300_000;
const seen = new Map<string, number>();
let lastSweep = Date.now();

function rejectReplay(timestamp: string, signature: string, now: number): void {
  const key = `${timestamp}:${signature}`;
  if (now - lastSweep >= REPLAY_WINDOW_MS) {
    lastSweep = now;
    for (const [k, expiresAt] of seen) if (expiresAt <= now) seen.delete(k);
  }
  const expiresAt = seen.get(key);
  if (expiresAt !== undefined && expiresAt > now) throw new DomainError("UNAUTHENTICATED", "This Slack request was already used");
  seen.set(key, now + REPLAY_WINDOW_MS);
}

/** Tests only: a fresh process would start empty. */
export function resetSlackReplayCache(): void {
  seen.clear();
  lastSweep = Date.now();
}

/**
 * Slack request signing (api.slack.com/authentication/verifying-requests-from-slack):
 * `v0=` HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the app's signing secret, and a timestamp
 * within five minutes (replays are refused). Without a secret, Slack routes refuse everything.
 */
export function verifySlackSignature(args: { rawBody: string | undefined; timestamp: string | undefined; signature: string | undefined; secret: string | undefined; now?: number; retryNum?: string | undefined; retryReason?: string | undefined }): void {
  if (!args.secret) throw new DomainError("FORBIDDEN", "Slack is not connected (no signing secret)");
  if (args.rawBody === undefined || !args.timestamp || !args.signature) throw new DomainError("FORBIDDEN", "Not a signed Slack request");
  const nowMs = args.now ?? Date.now();
  const ts = Number(args.timestamp);
  const now = Math.floor(nowMs / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) throw new DomainError("FORBIDDEN", "Slack request is too old");
  const expected = `v0=${createHmac("sha256", args.secret).update(`v0:${args.timestamp}:${args.rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(args.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError("FORBIDDEN", "Bad Slack signature");
  // Slack's own retry of a request we may not have answered in time must still get through
  // (api.slack.com/apis/rtm# retries): only a genuine replay of an already-answered request is refused.
  if (args.retryNum !== undefined && args.retryReason === "http_timeout") return;
  rejectReplay(args.timestamp, args.signature, nowMs);
}

/** Signs a body as Slack would (tests, local tools). */
export function signSlackBody(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)): { "x-slack-request-timestamp": string; "x-slack-signature": string } {
  return { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}` };
}
