import { readFileSync } from "node:fs";
import { SignJWT, importJWK, type JWK } from "jose";
import { ISSUER, KEY_FILE, PROJECT, STATE_FILE, type E2EState } from "./env.js";

export const state = (): E2EState => JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2EState;

/** A signed Identity Platform shaped ID token for a golden persona (email + Google identity). */
export async function tokenFor(persona: string, opts: { key?: "e2e" | "foreign"; expiresIn?: string } = {}): Promise<string> {
  const { slug } = state();
  const { kid, jwk } = JSON.parse(readFileSync(KEY_FILE, "utf8")) as { kid: string; jwk: JWK };
  const key = opts.key === "foreign" ? (await import("jose")).generateKeyPair("RS256").then((p) => p.privateKey) : importJWK(jwk, "RS256");
  return new SignJWT({ email: `${persona.toLowerCase()}@${slug}.golden.test`, email_verified: true, firebase: { sign_in_provider: "google.com", identities: { "google.com": [`golden-${slug}-${persona}`] } } })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(PROJECT)
    .setSubject(`e2e-${persona}`)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "30m")
    .sign(await key);
}
