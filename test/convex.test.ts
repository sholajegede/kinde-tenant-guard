// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { convexTenantGuard } from "../src/convex.js";
import { audit } from "./convex/guard.js";
import schema from "./convex/schema.js";

const api = anyApi.functions as any;
const modules = import.meta.glob("./convex/**/*.ts");
const issuer = "https://acme.kinde.com";
const all = ["projects:read", "projects:write", "projects:delete", "invoices:read", "invoices:write"];

const identity = (orgCode: string | undefined, permissions = all) => ({ subject: `kp_${orgCode ?? "none"}`, issuer, org_code: orgCode, permissions, roles: [{ id: "r1", key: "admin" }] });

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const acme = await ctx.db.insert("tenants", { orgCode: "org_acme", name: "Acme" });
    const globex = await ctx.db.insert("tenants", { orgCode: "org_globex", name: "Globex" });
    const acmePortal = await ctx.db.insert("projects", { tenantId: acme, name: "Customer portal", slug: "acme-portal" });
    await ctx.db.insert("projects", { tenantId: acme, name: "Billing app", slug: "acme-billing" });
    const globexBilling = await ctx.db.insert("projects", { tenantId: globex, name: "Billing revamp", slug: "globex-billing" });
    const globexInvoice = await ctx.db.insert("invoices", { tenantId: globex, projectId: globexBilling, amount: 9000 });
    await ctx.db.insert("plans", { name: "free" });
    await ctx.db.insert("auditLog", { message: "boot" });
    return { acme, globex, acmePortal, globexBilling, globexInvoice };
  });
  return { t, ids, acme: t.withIdentity(identity("org_acme")), globex: t.withIdentity(identity("org_globex")) };
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  audit.length = 0;
  env = await setup();
});

describe("convex reads", () => {
  it("only returns the active organization's documents", async () => {
    expect((await env.acme.query(api.listProjects, {})).sort()).toEqual(["acme-billing", "acme-portal"]);
    expect(await env.globex.query(api.listProjects, {})).toEqual(["globex-billing"]);
    expect(await env.acme.query(api.orderedProjects, {})).toHaveLength(2);
  });

  it("fills in the tenant on indexes that start with the tenant field", async () => {
    expect(await env.acme.query(api.projectBySlug, { slug: "acme-portal" })).toBe("Customer portal");
    expect(await env.acme.query(api.projectBySlug, { slug: "globex-billing" })).toBeNull();
  });

  it("refuses indexes that do not start with the tenant field", async () => {
    await expect(env.acme.query(api.unscopedIndex, { slug: "globex-billing" })).rejects.toThrow(/does not start with "tenantId"/);
    expect(audit.at(-1)).toMatchObject({ type: "access.denied", code: "UNSAFE_QUERY" });
  });

  it("scopes search through a search index that filters on the tenant field", async () => {
    expect(await env.acme.query(api.search, { text: "Billing" })).toEqual(["acme-billing"]);
    await expect(env.acme.query(api.unscopedSearch, { text: "Billing" })).rejects.toThrow(/filterFields/);
  });

  it("returns null for another tenant's document, by either get() form", async () => {
    for (const withTable of [true, false]) {
      expect(await env.acme.query(api.getProject, { id: env.ids.acmePortal, withTable })).toBe("acme-portal");
      expect(await env.acme.query(api.getProject, { id: env.ids.globexBilling, withTable })).toBeNull();
    }
  });

  it("lets every tenant read shared tables and refuses unregistered ones", async () => {
    expect(await env.acme.query(api.readPlans, {})).toEqual(["free"]);
    await expect(env.acme.query(api.readUnregistered, {})).rejects.toThrow(/not registered/);
  });

  it("gives queries a read-only database", async () => {
    expect(await env.acme.query(api.queryHasNoWriter, {})).toBe("undefined");
  });
});

describe("convex writes", () => {
  it("stamps inserts with the tenant and refuses another tenant's ID", async () => {
    expect(await env.acme.mutation(api.createProject, { name: "New", slug: "acme-new" })).toBe(env.ids.acme);
    expect(await env.acme.mutation(api.createProject, { name: "New", slug: "acme-new-2", tenantId: env.ids.acme })).toBe(env.ids.acme);
    await expect(env.acme.mutation(api.createProject, { name: "Bad", slug: "x", tenantId: env.ids.globex })).rejects.toThrow(/names another tenant/);
    expect(await env.globex.query(api.listProjects, {})).toEqual(["globex-billing"]);
  });

  it("refuses patch, replace and delete on another tenant's document", async () => {
    for (const withTable of [true, false]) {
      await expect(env.acme.mutation(api.renameProject, { id: env.ids.globexBilling, name: "taken", withTable })).rejects.toThrow(/belongs to another tenant/);
    }
    await expect(env.acme.mutation(api.replaceProject, { id: env.ids.globexBilling, name: "taken", slug: "taken" })).rejects.toThrow(/belongs to another tenant/);
    await expect(env.acme.mutation(api.deleteProject, { id: env.ids.globexBilling })).rejects.toThrow(/belongs to another tenant/);
    expect(await env.globex.query(api.projectBySlug, { slug: "globex-billing" })).toBe("Billing revamp");
  });

  it("updates the tenant's own documents", async () => {
    await env.acme.mutation(api.renameProject, { id: env.ids.acmePortal, name: "Portal v2", withTable: false });
    expect(await env.acme.query(api.projectBySlug, { slug: "acme-portal" })).toBe("Portal v2");
    expect(await env.acme.mutation(api.replaceProject, { id: env.ids.acmePortal, name: "Portal v3", slug: "acme-portal" })).toBe(env.ids.acme);
    await env.acme.mutation(api.deleteProject, { id: env.ids.acmePortal });
    expect(await env.acme.query(api.listProjects, {})).toEqual(["acme-billing"]);
  });

  it("refuses moving a document to another tenant", async () => {
    await expect(env.acme.mutation(api.moveProject, { id: env.ids.acmePortal, tenantId: env.ids.globex })).rejects.toThrow(/cannot move/);
  });

  it("scopes ctx.db.table() the same way", async () => {
    expect(await env.acme.mutation(api.tableApi, { name: "via-table" })).toEqual({ tenantId: env.ids.acme, count: 3 });
  });

  it("refuses writes to shared tables", async () => {
    await expect(env.acme.mutation(api.writePlan, {})).rejects.toThrow(/shared by all tenants/);
  });

  it("refuses a database kept after its scope ended", async () => {
    await env.acme.mutation(api.saveDatabase, {});
    await expect(env.acme.mutation(api.useSavedDatabase, {})).rejects.toThrow(/after its scope ended/);
  });
});

describe("convex principals and policies", () => {
  it("refuses callers without a token or an active organization", async () => {
    await expect(env.t.query(api.listProjects, {})).rejects.toThrow(/no subject or issuer/);
    await expect(env.t.withIdentity(identity(undefined)).query(api.listProjects, {})).rejects.toThrow(/no active organization/);
    await expect(env.t.withIdentity(identity("org_unknown")).query(api.listProjects, {})).rejects.toThrow(/No tenant is mapped/);
  });

  it("checks the permission for each action", async () => {
    const reader = env.t.withIdentity(identity("org_acme", ["projects:read"]));
    expect(await reader.query(api.listProjects, {})).toHaveLength(2);
    await expect(reader.mutation(api.createProject, { name: "x", slug: "x" })).rejects.toThrow(/needs the "projects:write" permission/);
    await expect(env.globex.mutation(api.deleteInvoice, { id: env.ids.globexInvoice })).rejects.toThrow(/allows no "delete" action/);
    expect(audit.at(-1)).toMatchObject({ type: "access.denied", code: "FORBIDDEN" });
  });
});

describe("convex system access", () => {
  it("reaches every tenant without a tenantId, and one tenant with it", async () => {
    expect(await env.t.query(api.nightlyCount, {})).toBe(3);
    expect(await env.t.query(api.nightlyCount, { tenantId: env.ids.globex })).toBe(1);
    expect(audit.filter((e) => e.type === "system.access")).toHaveLength(2);
  });
});

describe("convex setup checks", () => {
  it("refuses tenant tables without an index on the tenant field", () => {
    const bad = defineSchema({ notes: defineTable({ tenantId: v.string() }).index("by_other", ["tenantId_x" as never]) });
    expect(() => convexTenantGuard({ schema: bad, tables: ["notes"], tenantField: "tenantId", resolveTenant: () => null })).toThrow(/needs an index that starts with "tenantId"/);
    expect(() => convexTenantGuard({ schema, tables: ["missing"], tenantField: "tenantId", resolveTenant: () => null })).toThrow(/no "missing" table/);
  });
});
