import { DomainError } from "@budget/domain";
import { Injectable } from "@nestjs/common";
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/** Google's public keys for Identity Platform (securetoken) ID tokens. */
const IDENTITY_PLATFORM_JWKS = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface VerifiedIdentity {
  /** Identity Platform uid (`sub`). */
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Google account id from `firebase.identities["google.com"]`, when signed in with Google. */
  googleSub: string | null;
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

/** Reads AUTH_* from the environment. There is no bypass: missing config fails at startup. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const audience = env["AUTH_AUDIENCE"];
  if (!audience) throw new Error("AUTH_AUDIENCE is required (Identity Platform project id)");
  return {
    audience,
    issuer: env["AUTH_ISSUER"] ?? `https://securetoken.google.com/${audience}`,
    jwksUrl: env["AUTH_JWKS_URL"] ?? IDENTITY_PLATFORM_JWKS,
  };
}

/** Validates Identity Platform ID tokens (RS256) against the configured JWKS, issuer and audience. */
@Injectable()
export class JwtVerifier {
  private readonly config: AuthConfig;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    this.config = authConfigFromEnv();
    this.jwks = createRemoteJWKSet(new URL(this.config.jwksUrl));
  }

  async verify(authorization: string | undefined): Promise<VerifiedIdentity> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
    const token = match?.[1];
    if (token === undefined) throw new DomainError("UNAUTHENTICATED", "Missing bearer token");
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ["RS256"],
      }));
    } catch (error) {
      const reason = error instanceof errors.JOSEError ? error.code : "ERR_JWT_INVALID";
      throw new DomainError("UNAUTHENTICATED", "Invalid token", { reason });
    }
    const email = typeof payload["email"] === "string" ? payload["email"].toLowerCase() : null;
    if (!payload.sub || email === null) throw new DomainError("UNAUTHENTICATED", "Token lacks sub or email");
    return { sub: payload.sub, email, emailVerified: payload["email_verified"] === true, googleSub: googleIdentity(payload) };
  }
}

function googleIdentity(payload: JWTPayload): string | null {
  const firebase = payload["firebase"];
  if (typeof firebase !== "object" || firebase === null) return null;
  const identities = (firebase as { identities?: Record<string, unknown> }).identities;
  const google = identities?.["google.com"];
  return Array.isArray(google) && typeof google[0] === "string" ? google[0] : null;
}
