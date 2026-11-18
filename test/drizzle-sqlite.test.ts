import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { createTenantGuard, isTenantGuardError } from "../src/index.js";
import { drizzleAdapter } from "../src/drizzle.js";
import { principal } from "./setup.js";

const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
});

const sqlite = new Database(":memory:");
sqlite.exec("create table projects (id integer primary key autoincrement, tenant_id text not null, name text not null)");
const db = drizzle(sqlite);
const adapter = drizzleAdapter(db, { tables: { projects }, tenantColumn: "tenantId" });
const guard = createTenantGuard({ adapter, resolveTenant: (code) => ({ org_acme: "t_acme", org_globex: "t_globex" })[code] ?? null });

describe("SQLite, with the scoped helpers", () => {
  it("is not row-level security, and says so", async () => {
    expect(adapter.rls).toBe(false);
    expect((await guard.verify()).checks[0]!.detail).toMatch(/Only the scoped table helpers/);
    expect(() => drizzleAdapter(db, { tables: { projects }, tenantColumn: "tenantId", rls: true })).toThrow(/needs a PostgreSQL/);
  });

  it("keeps each tenant's rows apart", async () => {
    const acme = await principal("org_acme");
    const globex = await principal("org_globex");
    await guard.withTenant(acme, (t) => t.table(projects).insert([{ name: "Portal" }, { name: "Mobile app" }]));
    await guard.withTenant(globex, (t) => t.table(projects).insert({ name: "Billing" }));

    await guard.withTenant(acme, async (t) => {
      expect((await t.table(projects).findMany()).map((r) => [r.tenantId, r.name])).toEqual([
        ["t_acme", "Portal"],
        ["t_acme", "Mobile app"],
      ]);
      const billing = (await guard.withTenant(globex, (g) => g.table(projects).findFirst()))!;
      expect(await t.table(projects).update({ name: "taken" }, { where: eq(projects.id, billing.id) })).toEqual([]);
      expect(await t.table(projects).delete({ where: eq(projects.id, billing.id) })).toEqual([]);
      expect(isTenantGuardError(await t.table(projects).insert({ name: "x", tenantId: "t_globex" }).catch((e) => e), "CROSS_TENANT_WRITE")).toBe(true);
      expect(() => t.db).not.toThrow();
      expect(() => (t.db as unknown as { select(): unknown }).select()).toThrow(/needs PostgreSQL row-level security/);
    });
    expect(await guard.withTenant(globex, (t) => t.table(projects).count())).toBe(1);
  });
});
