import { convexTenantGuard } from "../../src/convex.js";
import { definePolicies } from "../../src/policies.js";
import schema from "./schema.js";

export const audit: Array<{ type: string; code?: string }> = [];

export const policies = definePolicies({
  projects: { tenant: "required", permissions: { read: "projects:read", create: "projects:write", update: "projects:write", delete: "projects:delete" } },
  invoices: { tenant: "required", permissions: { read: "invoices:read", create: "invoices:write" } },
  plans: { tenant: "global", permissions: { read: "projects:read" } },
});

export const tenants = convexTenantGuard({
  schema,
  tables: ["projects", "invoices"],
  shared: ["plans"],
  tenantField: "tenantId",
  policies,
  onAudit: (event) => audit.push(event),
  async resolveTenant(ctx, organizationCode) {
    const tenant = await ctx.db.query("tenants").withIndex("by_org", (q) => q.eq("orgCode", organizationCode)).unique();
    return tenant?._id ?? null;
  },
});
