import { describe, expect, it } from "vitest";
import { parseRequestRef, parseSlackCommand } from "./slack-command.js";
import { shortRequestId } from "./slack.js";

const ID = "01a0e815-72fb-70ba-8af9-be3a07080b21";

describe("/budget text (S-007)", () => {
  it("reads the verbs, and anything else as a budget's name", () => {
    expect(parseSlackCommand("")).toEqual({ verb: "summary" });
    expect(parseSlackCommand("  help ")).toEqual({ verb: "help" });
    expect(parseSlackCommand("approvals")).toEqual({ verb: "approvals" });
    expect(parseSlackCommand("Inbox")).toEqual({ verb: "approvals" });
    expect(parseSlackCommand("alerts")).toEqual({ verb: "alerts" });
    expect(parseSlackCommand("search meta brazil")).toEqual({ verb: "search", text: "meta brazil" });
    expect(parseSlackCommand("list")).toEqual({ verb: "list", text: "" });
    expect(parseSlackCommand("list LATAM")).toEqual({ verb: "list", text: "LATAM" });
    expect(parseSlackCommand("workspace OpenAI")).toEqual({ verb: "workspace", text: "OpenAI" });
    expect(parseSlackCommand("request Brazil Meta")).toEqual({ verb: "request", text: "Brazil Meta" });
    expect(parseSlackCommand("Brazil  Meta")).toEqual({ verb: "budget", text: "Brazil  Meta" });
  });

  it("reads decisions with a request reference and the rest as the comment", () => {
    expect(parseSlackCommand("approve #BE3A0708")).toEqual({ verb: "approve", ref: { kind: "suffix", suffix: "be3a0708" }, text: "" });
    expect(parseSlackCommand("reject be3a0708 over the Q4 cap")).toEqual({ verb: "reject", ref: { kind: "suffix", suffix: "be3a0708" }, text: "over the Q4 cap" });
    expect(parseSlackCommand(`changes ${ID} split it by month`)).toEqual({ verb: "changes", ref: { kind: "id", id: ID }, text: "split it by month" });
    expect(parseSlackCommand("withdraw #be3a0708")).toMatchObject({ verb: "withdraw", ref: { suffix: "be3a0708" } });
    expect(parseSlackCommand("remind #be3a0708")).toMatchObject({ verb: "remind", ref: { suffix: "be3a0708" } });
    expect(parseSlackCommand("approve brazil")).toEqual({ verb: "approve", ref: null, text: "brazil" });
  });

  it("show takes a request, else a budget's name", () => {
    expect(parseSlackCommand("show #be3a0708")).toEqual({ verb: "show", ref: { kind: "suffix", suffix: "be3a0708" }, text: "" });
    expect(parseSlackCommand("show Brazil Meta")).toEqual({ verb: "budget", text: "Brazil Meta" });
  });

  it("takes a pasted link, plain or as Slack wraps it", () => {
    expect(parseRequestRef(`https://budgetos.example/w/x/approvals/${ID}`)).toEqual({ kind: "id", id: ID });
    expect(parseRequestRef(`<https://budgetos.example/w/x/approvals/${ID}|Review>`)).toEqual({ kind: "id", id: ID });
    expect(parseRequestRef("#nothex00")).toBeNull();
    expect(parseRequestRef("be3a07")).toBeNull();
  });

  it("shows a request as # and the last eight characters of its id", () => {
    expect(shortRequestId(ID)).toBe("#07080b21");
    expect(parseRequestRef(shortRequestId(ID))).toEqual({ kind: "suffix", suffix: ID.slice(-8) });
  });
});
