import type { AuthConfig } from "convex/server";

// Convex checks the Kinde access token, not the ID token: the access token carries org_code and
// permissions, which the guard needs. Its aud is the Kinde API audience, so that is the applicationID.
export default {
  providers: [
    {
      type: "customJwt",
      issuer: process.env.KINDE_ISSUER_URL!,
      jwks: `${process.env.KINDE_ISSUER_URL}/.well-known/jwks.json`,
      algorithm: "RS256",
      applicationID: process.env.KINDE_AUDIENCE!,
    },
  ],
} satisfies AuthConfig;
