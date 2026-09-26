import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { AUTH_DIR, KEY_FILE, PORTS } from "./env.js";

/**
 * A local JWKS for Identity Platform shaped test tokens (LOCAL_BUILD_PHASES finding 9): the API
 * verifies e2e tokens against it exactly as it verifies Google's. The private key is written for
 * the tests to sign with; nothing skips verification.
 */
// JWKS_PERSIST=1 (the persistent local stack) keeps the key across restarts, so its tokens stay valid.
mkdirSync(AUTH_DIR, { recursive: true });
let kid: string;
let publicJwk: JWK;
if (process.env["JWKS_PERSIST"] === "1" && existsSync(KEY_FILE)) {
  const saved = JSON.parse(readFileSync(KEY_FILE, "utf8")) as { kid: string; jwk: JWK };
  kid = saved.kid;
  const { kty, n, e } = saved.jwk;
  publicJwk = { kty, n, e } as JWK;
} else {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  kid = `e2e-${Date.now()}`;
  writeFileSync(KEY_FILE, JSON.stringify({ kid, jwk: await exportJWK(privateKey) }));
  publicJwk = await exportJWK(publicKey);
}
const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
createServer((req, res) => {
  res.writeHead(req.url === "/jwks" ? 200 : 404, { "content-type": "application/json" });
  res.end(req.url === "/jwks" ? jwks : "{}");
}).listen(PORTS.jwks, "127.0.0.1");
