import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair } from "jose";
import { AUTH_DIR, KEY_FILE, PORTS } from "./env.js";

/**
 * A local JWKS for Identity Platform shaped test tokens (LOCAL_BUILD_PHASES finding 9): the API
 * verifies e2e tokens against it exactly as it verifies Google's. The private key is written for
 * the tests to sign with; nothing skips verification.
 */
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const kid = `e2e-${Date.now()}`;
mkdirSync(AUTH_DIR, { recursive: true });
writeFileSync(KEY_FILE, JSON.stringify({ kid, jwk: await exportJWK(privateKey) }));
const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }] });
createServer((req, res) => {
  res.writeHead(req.url === "/jwks" ? 200 : 404, { "content-type": "application/json" });
  res.end(req.url === "/jwks" ? jwks : "{}");
}).listen(PORTS.jwks, "127.0.0.1");
