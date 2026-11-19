import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { createTenantGuard, isTenantGuardError } from "../src/index.js";
import { prismaAdapter } from "../src/prisma.js";
import { PrismaClient } from "./prisma/generated-sqlite/client.js";
import { principal } from "./setup.js";

const file = join(mkdtempSync(join(tmpdir(), "tenant-guard-sqlite-")), "test.db");
const setup = new Database(file);
setup.exec(`
  create table projects (id integer primary key autoincrement, tenant_id text not null, name text not null);
  create table invoices (id integer primary key autoincrement, tenant_id text not null, project_id integer not null references projects(id), amount integer not null);
`);
setup.close();

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
const adapter = prismaAdapter(prisma, { models: { projects: "Project", invoices: "Invoice" }, tenantField: "tenantId" });
const guard = createTenantGuard({ adapter, resolveTenant: (code) => ({ org_acme: "t_acme", org_globex: "t_globex" })[code] ?? null });
afterAll(() => prisma.$disconnect());

const refused = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe("Prisma on SQLite, without row-level security", () => {
  it("knows there is no row-level security", async () => {
    expect(adapter.rls).toBe(false);
    expect(adapter.migrationSql()).toMatch(/no SQL to run/);
    expect(() => prismaAdapter(prisma, { models: { projects: "Project" }, tenantField: "tenantId", rls: true })).toThrow(/needs PostgreSQL/);
  });

  it("filters, stamps and refuses cross-tenant writes on the registered models", async () => {
    const acme = await principal("org_acme");
    const globex = await principal("org_globex");
    const acmeProject = await guard.withTenant(acme, (t) => t.db.project.create({ data: { name: "Portal", tenantId: "t_acme" } }));
    const globexProject = await guard.withTenant(globex, (t) => t.db.project.create({ data: { name: "Billing", tenantId: "t_globex" } }));
    await guard.withTenant(globex, (t) => t.db.invoice.createMany({ data: [{ projectId: globexProject.id, amount: 9000, tenantId: "t_globex" }] }));

    await guard.withTenant(acme, async (t) => {
      expect((await t.db.project.findMany()).map((p) => p.name)).toEqual(["Portal"]);
      expect(await t.db.invoice.count()).toBe(0);
      expect(await t.db.project.findUnique({ where: { id: globexProject.id } })).toBeNull();
      expect((await t.db.project.updateMany({ where: { id: globexProject.id }, data: { name: "taken" } })).count).toBe(0);
      expect((await t.db.invoice.deleteMany()).count).toBe(0);
      expect(isTenantGuardError(await refused(t.db.project.create({ data: { name: "x", tenantId: "t_globex" } })), "CROSS_TENANT_WRITE")).toBe(true);
      expect(isTenantGuardError(await refused(t.db.project.update({ where: { id: acmeProject.id }, data: { tenantId: "t_globex" } })), "CROSS_TENANT_WRITE")).toBe(true);
    });
    expect(await guard.withTenant(globex, (t) => t.db.invoice.count())).toBe(1);
  });

  it("refuses nested relation reads, nested writes and raw SQL, which it cannot limit", async () => {
    const acme = await principal("org_acme");
    await guard.withTenant(acme, async (t) => {
      expect(isTenantGuardError(await refused(t.db.project.findMany({ include: { invoices: true } })), "UNSAFE_QUERY")).toBe(true);
      expect(isTenantGuardError(await refused(t.db.invoice.findMany({ select: { id: true, project: true } })), "UNSAFE_QUERY")).toBe(true);
      expect(isTenantGuardError(await refused(t.db.project.create({ data: { name: "n", tenantId: "t_acme", invoices: { create: { amount: 1, tenantId: "t_acme" } } } })), "UNSAFE_QUERY")).toBe(true);
      expect(isTenantGuardError(await refused(t.db.$queryRaw`select * from projects`), "UNSAFE_QUERY")).toBe(true);
      // Plain field selection is fine.
      expect(await t.db.project.findMany({ select: { id: true, name: true } })).toHaveLength(1);
    });
  });
});
