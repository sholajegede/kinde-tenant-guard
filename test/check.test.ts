import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProject, type CheckReport } from "../src/check.js";
import { tenantRlsSql } from "../src/drizzle.js";
import { invoices, projects } from "./schema.js";
import { ownerPool, resetDatabase } from "./setup.js";

const dirs: string[] = [];
async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "tg-check-"));
  dirs.push(dir);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), source);
  }
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const summary = (report: CheckReport) => report.findings.map((f) => `${f.rule} ${f.file}:${f.line}`);

const drizzleFiles = {
  "src/db/schema.ts": `import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";
import { tenantIdColumn } from "kinde-tenant-guard/drizzle";
export const tenants = pgTable("tenants", { id: text("id").primaryKey(), kindeOrgCode: text("kinde_org_code").notNull() });
export const projects = pgTable("projects", { id: serial("id").primaryKey(), tenantId: tenantIdColumn(), name: text("name").notNull() });
export const invoices = pgTable("invoices", (t) => ({ id: t.serial("id").primaryKey(), tenantId: t.text("tenant_id").notNull(), amount: integer("amount") }));
export const notes = pgTable("notes", { id: serial("id").primaryKey(), tenantId: text("tenant_id").notNull(), body: text("body") });
`,
  "src/db/guard.ts": `import { createTenantGuard } from "kinde-tenant-guard";
import { drizzleAdapter } from "kinde-tenant-guard/drizzle";
import { db } from "./client";
import { invoices, projects, tenants } from "./schema";
export const adapter = drizzleAdapter(db, { tables: { projects, invoices }, tenantColumn: "tenantId" });
export const guard = createTenantGuard({
  adapter,
  resolveTenant: async (code: string) => (await db.select().from(tenants).where(eq(tenants.kindeOrgCode, code)))[0]?.id ?? null,
});
`,
  "src/routes/invoices.ts": `import { db } from "../db/client";
export async function list(principal: unknown) {
  const safe = await guard.withTenant(principal, (tenant) => tenant.db.select().from(invoices));
  const leaky = await db.select().from(invoices);
  // eslint-disable-next-line kinde-tenant-guard/no-unguarded-db -- reviewed: health check
  await db.execute(sql\`select 1\`);
  return { safe, leaky };
}
`,
  "src/routes/invoices.test.ts": `await db.insert(invoices).values({ amount: 1 });\n`,
  "scripts/seed.ts": `await db.insert(projects).values({ name: "seed" });\n`,
  "dist/server.js": `db.select();\n`,
  "src/types.d.ts": `declare const x: typeof db.select;\n`,
};

describe("checkProject() with Drizzle", () => {
  it("finds raw client access and tenant tables the guard does not cover", async () => {
    const report = await checkProject({ cwd: await project(drizzleFiles) });
    expect(report.ok).toBe(false);
    expect(summary(report)).toEqual(["no-unguarded-db scripts/seed.ts:1", "unregistered-tenant-table src/db/schema.ts:6", "no-unguarded-db src/routes/invoices.ts:4"]);
    expect(report.findings[1]!.message).toMatch(/"notes" table has a "tenantId" column but is not registered/);
    expect(report.files).toBe(4);
  });

  it("skips ignored paths, and checks test files on request", async () => {
    const cwd = await project(drizzleFiles);
    expect(summary(await checkProject({ cwd, ignore: ["scripts/**"] }))).not.toContain("no-unguarded-db scripts/seed.ts:1");
    expect(summary(await checkProject({ cwd, includeTests: true }))).toContain("no-unguarded-db src/routes/invoices.test.ts:1");
  });

  it("reports a registered table without the tenant column", async () => {
    const cwd = await project({
      ...drizzleFiles,
      "src/db/guard.ts": `export const adapter = drizzleAdapter(db, { tables: { projects, invoices, tenants, ghosts }, tenantColumn: "tenantId" });\n`,
    });
    const report = await checkProject({ cwd, paths: ["src/db"] });
    expect(summary(report)).toEqual(["unknown-table src/db/guard.ts:1", "missing-tenant-column src/db/schema.ts:3", "unregistered-tenant-table src/db/schema.ts:6"]);
  });

  it("passes a project where every access goes through the guard", async () => {
    const cwd = await project({
      "schema.ts": drizzleFiles["src/db/schema.ts"].replace(/export const notes.*\n/, ""),
      "guard.ts": drizzleFiles["src/db/guard.ts"],
      "routes.ts": `export const list = (p: unknown) => guard.withTenant(p, (tenant) => tenant.table(invoices).findMany());\n`,
    });
    expect(await checkProject({ cwd })).toMatchObject({ ok: true, findings: [] });
  });
});

describe("checkProject() with Prisma", () => {
  it("checks models against prismaAdapter() and the tenant default", async () => {
    const cwd = await project({
      "prisma/schema.prisma": `datasource db {
  provider = "postgresql"
}
model Project {
  id       Int    @id
  tenantId String @default(dbgenerated("NULLIF(current_setting('app.tenant_id', true), '')")) @map("tenant_id")
  @@map("projects")
}
model Invoice {
  id       Int    @id
  tenantId String @map("tenant_id")
}
model Note {
  id       Int    @id
  tenantId String
}
model Plan {
  id Int @id
}
`,
      "src/guard.ts": `export const adapter = prismaAdapter(prisma, { models: { projects: "Project", invoices: "Invoice" }, tenantField: "tenantId" });
export const list = () => prisma.invoice.findMany();
`,
    });
    const report = await checkProject({ cwd });
    expect(summary(report)).toEqual(["missing-tenant-default prisma/schema.prisma:11", "unregistered-tenant-table prisma/schema.prisma:13", "no-unguarded-db src/guard.ts:2"]);
    expect(report.findings[0]!.severity).toBe("warning");
  });
});

describe("checkProject() with Convex", () => {
  it("checks tables, tenant indexes and ctx.db", async () => {
    const cwd = await project({
      "convex/schema.ts": `export default defineSchema({
  tenants: defineTable({ orgCode: v.string() }).index("by_org", ["orgCode"]),
  projects: defineTable({ tenantId: v.string(), name: v.string() }).index("by_tenant", ["tenantId"]),
  invoices: defineTable(v.object({ tenantId: v.string(), projectId: v.id("projects") })).index("by_project", ["projectId"]),
  notes: defineTable({ tenantId: v.string(), body: v.string() }).index("by_tenant", { fields: ["tenantId"] }),
});
`,
      "convex/tenant.ts": `export const tenants = convexTenantGuard({
  schema,
  tables: ["projects", "invoices"],
  tenantField: "tenantId",
  resolveTenant: async (ctx, code) => (await ctx.db.query("tenants").withIndex("by_org", (q) => q.eq("orgCode", code)).unique())?._id ?? null,
});
`,
      "convex/projects.ts": `export const list = query({ handler: (ctx) => tenants.withTenant(ctx, (t) => t.db.query("projects").collect()) });
export const leak = query({ handler: (ctx) => ctx.db.query("projects").collect() });
`,
      "convex/_generated/api.js": `export const api = ctx.db;\n`,
    });
    const report = await checkProject({ cwd });
    expect(summary(report)).toEqual(["no-unguarded-db convex/projects.ts:2", "missing-tenant-index convex/schema.ts:4", "unregistered-tenant-table convex/schema.ts:5"]);
  });
});

describe("checkProject() with a database", () => {
  const owner = ownerPool();
  const base = `postgres://%s@127.0.0.1:${process.env.TENANT_GUARD_TEST_PORT}/tg_test`;
  beforeAll(async () => {
    await resetDatabase(owner, tenantRlsSql({ projects, invoices }, "tenantId"));
  });
  afterAll(async () => {
    await owner.end();
  });

  it("checks row-level security on the registered tables", async () => {
    const cwd = await project({ "schema.ts": drizzleFiles["src/db/schema.ts"].replace(/export const notes.*\n/, ""), "guard.ts": drizzleFiles["src/db/guard.ts"] });
    const good = await checkProject({ cwd, databaseUrl: base.replace("%s", "tg_app:app") });
    expect(good.ok).toBe(true);
    expect(good.database?.checks.map((c) => c.name)).toEqual(["database role", "projects (public.projects)", "invoices (public.invoices)"]);
    const superuser = await checkProject({ cwd, databaseUrl: base.replace("%s", `postgres:${process.env.TENANT_GUARD_TEST_PASSWORD}`) });
    expect(superuser.ok).toBe(false);
    expect(superuser.database?.checks[0]).toMatchObject({ name: "database role", ok: false });
  });
});
