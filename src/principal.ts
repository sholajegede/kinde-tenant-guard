import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { TenantGuardError } from "./errors.js";

/** A verified caller, as Kinde describes it. Build one with principalFromClaims() or verifyKindeToken(). */
export interface KindePrincipal {
  /** "machine" for M2M tokens from the client credentials grant. */
  type: "user" | "machine";
  /** The Kinde user ID, or the client ID for a machine. */
  subject: string;
  issuer: string;
  /** The active organization from the token's org_code. Null when the token has none. */
  organization: { code: string } | null;
  roles: string[];
  permissions: string[];
  claims?: Record<string, unknown>;
}

function strings(value: unknown): string[] {
  // Some token bridges hand arrays over as JSON text, so accept that form too.
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : item && typeof item === "object" && "key" in item ? String((item as { key: unknown }).key) : null))
    .filter((item): item is string => !!item);
}

/**
 * Turns the claims of a token you already verified into a principal. Only org_code becomes the
 * active organization: org_codes lists every organization the user belongs to, and belonging to
 * one is not the same as acting in it.
 */
export function principalFromClaims(verified: JWTPayload | object): KindePrincipal {
  const claims = verified as Record<string, unknown>;
  const gty = claims.gty;
  const machine = Array.isArray(gty) ? gty.includes("client_credentials") : gty === "client_credentials";
  // Convex hands claims over as a UserIdentity, which names sub and iss "subject" and "issuer".
  const subject = machine ? String(claims.azp ?? claims.client_id ?? "") : String(claims.sub ?? claims.subject ?? "");
  const orgCode = typeof claims.org_code === "string" && claims.org_code ? claims.org_code : null;
  return {
    type: machine ? "machine" : "user",
    subject,
    issuer: String(claims.iss ?? claims.issuer ?? ""),
    organization: orgCode ? { code: orgCode } : null,
    roles: strings(claims.roles),
    permissions: strings(claims.permissions),
    claims: { ...claims },
  };
}

export interface VerifyKindeTokenOptions {
  /** Your Kinde domain, such as https://acme.kinde.com. */
  issuer: string;
  /** The API audience the token must be issued for. */
  audience?: string | string[];
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Verifies a Kinde access token against the issuer's JWKS and returns its principal. */
export async function verifyKindeToken(token: string, options: VerifyKindeTokenOptions): Promise<KindePrincipal> {
  const issuer = options.issuer.replace(/\/+$/, "");
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: options.audience, algorithms: ["RS256"] });
    return principalFromClaims(payload);
  } catch (error) {
    throw new TenantGuardError("INVALID_PRINCIPAL", `The Kinde token could not be verified: ${error instanceof Error ? error.message : String(error)}`);
  }
}
