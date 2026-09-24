import { createServer, type IncomingMessage } from "node:http";
import { log } from "./log.js";

/**
 * Minimal Pub/Sub push endpoint for a Cloud Run subscriber (spec §19): POST / with the push body.
 * 2xx acknowledges; any error answers 500 so Pub/Sub redelivers (handlers are idempotent on the
 * outbox id). Push authentication (OIDC) is phase 20 (ADR-010).
 */
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function servePush(name: string, handle: (body: unknown) => Promise<unknown>, port = Number(process.env["PORT"] ?? 8080)) {
  return createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    body(req)
      .then(handle)
      .then(() => res.writeHead(204).end())
      .catch((error: unknown) => {
        log.error({ err: error, service: name }, "push handling failed; Pub/Sub will redeliver");
        res.writeHead(500).end();
      });
  }).listen(port);
}
