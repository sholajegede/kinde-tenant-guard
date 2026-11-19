import { principalFromClaims } from "kinde-tenant-guard";
import { mutation, query } from "./_generated/server";
import { tenants } from "./tenant";

/**
 * Registers the caller's active Kinde organization as a tenant the first time someone signs in to
 * it. The organization comes from the verified token, so a caller can only register their own.
 */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const orgCode = identity ? principalFromClaims(identity).organization?.code : undefined;
    if (!orgCode) return null;
    return tenants.withSystem(ctx, { reason: `register Kinde organization ${orgCode}` }, async (system) => {
      const existing = await system.db.query("tenants").withIndex("by_org", (q) => q.eq("kindeOrgCode", orgCode)).unique();
      if (existing) return existing._id;
      return system.db.insert("tenants", { kindeOrgCode: orgCode, name: orgCode });
    });
  },
});

/** What Convex received from Kinde, and the principal the guard builds from it. Shown on the page. */
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const principal = principalFromClaims(identity);
    return {
      claims: { org_code: identity.org_code ?? null, permissions: identity.permissions ?? null, roles: identity.roles ?? null },
      principal: { subject: principal.subject, organization: principal.organization?.code ?? null, permissions: principal.permissions, roles: principal.roles },
    };
  },
});
