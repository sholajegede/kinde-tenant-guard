import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import plugin, { noUnguardedDb } from "../src/eslint.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: "module" } });

tester.run("no-unguarded-db", noUnguardedDb, {
  valid: [
    "await guard.withTenant(principal, (tenant) => tenant.db.select().from(projects));",
    "await guard.withSystem({ reason: 'export' }, (system) => system.db.select().from(projects));",
    "const adapter = drizzleAdapter(db, { tables, tenantColumn: 'tenantId' });",
    "const guard = createTenantGuard({ adapter, resolveTenant: async (code) => (await db.select().from(tenants).where(eq(tenants.code, code)))[0]?.id });",
    "async function resolveTenant(code) { return prisma.tenant.findUnique({ where: { code } }); }",
    "const resolveTenant = async (code) => prisma.tenant.findUnique({ where: { code } });",
    "export const tenants = convexTenantGuard({ schema, resolveTenant: async (ctx, code) => ctx.db.query('tenants').collect() });",
    "export const list = query({ handler: (ctx) => tenants.withTenant(ctx, (t) => t.db.query('projects').collect()) });",
    "const rows = await database.select().from(projects);",
    { code: "const rows = await db.select().from(projects);", options: [{ clients: ["prisma"] }] },
  ],
  invalid: [
    { code: "const rows = await db.select().from(invoices);", errors: [{ messageId: "client" }] },
    { code: "const rows = await prisma.invoice.findMany();", errors: [{ messageId: "client" }] },
    { code: "await guard.withTenant(principal, () => db.select().from(invoices));", errors: [{ messageId: "client" }] },
    { code: "export const list = query({ handler: (ctx) => ctx.db.query('projects').collect() });", errors: [{ messageId: "convex" }] },
    { code: "export const list = query({ handler: async (ctx) => { const { db } = ctx; return db.query('projects').collect(); } });", errors: [{ messageId: "convex" }, { messageId: "client" }] },
    { code: "helper(ctx.db);", errors: [{ messageId: "convex" }] },
    { code: "const rows = await database.select().from(projects);", options: [{ clients: ["database"] }], errors: [{ messageId: "client" }] },
  ],
});

describe("recommended config", () => {
  it("turns the rule on as an error", ({ expect }) => {
    expect((plugin.configs.recommended as { rules: Record<string, string> }).rules).toEqual({ "kinde-tenant-guard/no-unguarded-db": "error" });
  });
});
