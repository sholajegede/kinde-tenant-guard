import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per Kinde organization. Shared by the guard, never reached from a tenant scope.
  tenants: defineTable({ kindeOrgCode: v.string(), name: v.string() }).index("by_org", ["kindeOrgCode"]),
  // Tenant data. Every read goes through an index that starts with tenantId.
  projects: defineTable({ tenantId: v.string(), name: v.string(), createdBy: v.string() }).index("by_tenant", ["tenantId"]),
});
