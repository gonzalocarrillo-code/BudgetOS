/**
 * `/budget` text, read into what was asked (S-007). Free text stays as typed: budget names and
 * searches are matched by the search index, not here. A request is named by its short id (the
 * last eight characters of its uuid, shown as `#a1b2c3d4` in every Slack message), its full uuid,
 * or a pasted link to it.
 */

export type RequestRef = { kind: "id"; id: string } | { kind: "suffix"; suffix: string };

export type DecisionVerb = "approve" | "reject" | "changes" | "withdraw" | "remind";

export type SlackCommand =
  | { verb: "help" }
  | { verb: "summary" }
  | { verb: "approvals" }
  | { verb: "alerts" }
  | { verb: "search"; text: string }
  | { verb: "list"; text: string }
  | { verb: "workspace"; text: string }
  | { verb: "request"; text: string }
  | { verb: "budget"; text: string }
  | { verb: "show"; ref: RequestRef; text: string }
  | { verb: DecisionVerb; ref: RequestRef | null; text: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINKED = /\/approvals\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const SUFFIX = /^#?([0-9a-f]{8})$/i;
const DECISIONS: readonly DecisionVerb[] = ["approve", "reject", "changes", "withdraw", "remind"];


/** A request reference in one token, or null. Slack may wrap links as `<url|label>`. */
export function parseRequestRef(token: string): RequestRef | null {
  const t = token.trim().replace(/^<([^|>]*)(\|[^>]*)?>$/, "$1");
  const linked = LINKED.exec(t);
  if (linked?.[1]) return { kind: "id", id: linked[1].toLowerCase() };
  if (UUID.test(t)) return { kind: "id", id: t.toLowerCase() };
  const suffix = SUFFIX.exec(t);
  return suffix?.[1] ? { kind: "suffix", suffix: suffix[1].toLowerCase() } : null;
}

/** Splits off the first word; the rest keeps its spacing and case. */
function head(text: string): [string, string] {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
  return m ? [m[1] ?? "", (m[2] ?? "").trim()] : ["", ""];
}

export function parseSlackCommand(raw: string): SlackCommand {
  const text = raw.trim();
  if (text === "") return { verb: "summary" };
  const [first, rest] = head(text);
  const verb = first.toLowerCase();
  if (verb === "help" || verb === "?") return { verb: "help" };
  if (verb === "approvals" || verb === "inbox") return { verb: "approvals" };
  if (verb === "alerts") return { verb: "alerts" };
  if (verb === "search") return { verb: "search", text: rest };
  if (verb === "list") return { verb: "list", text: rest };
  if (verb === "workspace") return { verb: "workspace", text: rest };
  if (verb === "request") return { verb: "request", text: rest };
  if (verb === "show") {
    const [token, after] = head(rest);
    const ref = parseRequestRef(token);
    return ref ? { verb: "show", ref, text: after } : { verb: "budget", text: rest };
  }
  if ((DECISIONS as readonly string[]).includes(verb)) {
    const [token, after] = head(rest);
    const ref = parseRequestRef(token);
    return { verb: verb as DecisionVerb, ref, text: ref ? after : rest };
  }
  return { verb: "budget", text };
}
