import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({ orgCode: v.string(), name: v.string() }).index("by_org", ["orgCode"]),
  projects: defineTable({ tenantId: v.string(), name: v.string(), slug: v.string() })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_slug", ["tenantId", "slug"])
    .index("by_slug", ["slug"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["tenantId"] })
    .searchIndex("search_name_unscoped", { searchField: "name" }),
  invoices: defineTable({ tenantId: v.string(), projectId: v.id("projects"), amount: v.number() }).index("by_tenant_project", ["tenantId", "projectId"]),
  plans: defineTable({ name: v.string() }),
  auditLog: defineTable({ message: v.string() }),
});
