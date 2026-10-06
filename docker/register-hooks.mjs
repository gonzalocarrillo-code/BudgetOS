// Entry point for `NODE_OPTIONS=--import /app/docker/register-hooks.mjs` (set once in the
// runtime image's ENV, see Dockerfile). Registers docker/resolve-hooks.mjs so every `node`
// process in the container — the API, the worker, the MCP server, and the migrate job's
// bootstrap script — redirects "@budget/*" package resolution from TypeScript source to the
// compiled JavaScript sitting next to it, without any package.json changes.
import { register } from "node:module";

register(new URL("./resolve-hooks.mjs", import.meta.url));
