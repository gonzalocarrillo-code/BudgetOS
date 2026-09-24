import { pino } from "pino";

/** JSON logs (AGENTS.md §4). Handlers add requestId / workspaceId through child loggers. */
export const log = pino({ level: process.env["LOG_LEVEL"] ?? "info", base: { service: process.env["K_SERVICE"] ?? "workers" } });
