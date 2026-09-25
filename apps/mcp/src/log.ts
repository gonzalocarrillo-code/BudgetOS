import pino from "pino";

/** JSON logs (AGENTS §4): requestId, workspaceId and actorId on every tool line. */
export const log = pino({ base: { service: "mcp-readonly" }, level: process.env["LOG_LEVEL"] ?? "info" });
