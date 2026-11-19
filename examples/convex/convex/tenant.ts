import { ConvexError } from "convex/values";
import { definePolicies, isTenantGuardError } from "kinde-tenant-guard";
import { convexTenantGuard } from "kinde-tenant-guard/convex";
import schema from "./schema";

// The Kinde permission each action needs. Create these permissions in Kinde and give them to roles.
export const policies = definePolicies({
  projects: { tenant: "required", permissions: { read: "projects:read", create: "projects:create", delete: "projects:delete" } },
});

export const tenants = convexTenantGuard({
  schema,
  tables: ["projects"],
  tenantField: "tenantId",
  policies,
  resolveTenant: async (ctx, orgCode) =>
    (await ctx.db.query("tenants").withIndex("by_org", (q) => q.eq("kindeOrgCode", orgCode)).unique())?._id ?? null,
});

/** Convex only sends ConvexError details to the browser, so refusals are passed on as one. */
export async function asClientError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isTenantGuardError(error)) throw new ConvexError({ code: error.code, message: error.message });
    throw error;
  }
}
