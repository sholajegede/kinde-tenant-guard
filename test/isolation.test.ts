import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { KindeTestkit } from "kinde-testkit";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testIsolation, TenantIsolationError } from "../src/testing.js";
import { invoices, projects, schema } from "./schema.js";
import { appPool, makeGuard, ownerPool, resetDatabase, superPool, type Db } from "./setup.js";

const owner = ownerPool();
const app = appPool();
const root = superPool();
const db: Db = drizzle(app, { schema });
// A superuser connection skips row-level security, so code that uses it leaks across tenants.
const leaky = drizzle(root, { schema });
const { guard, adapter } = makeGuard(db);
const testkit = await KindeTestkit.create({ issuer: "https://acme.kinde.test" });
const organizations: [string, string] = ["org_acme", "org_globex"];

beforeEach(async () => {
  await resetDatabase(owner, adapter.migrationSql());
});
afterAll(async () => {
  await Promise.all([app.end(), owner.end(), root.end()]);
});

let counter = 0;
const slug = () => `iso-${++counter}`;

describe("testIsolation() with a guard", () => {
  it("passes when every operation goes through the tenant scope", async () => {
    const report = await testIsolation(guard, {
      organizations,
      testkit,
      resources: {
        projects: {
          create: async (t) => (await t.db.insert(projects).values({ slug: slug(), name: "Isolation" }).returning())[0],
          list: (t) => t.db.select().from(projects),
          get: async (t, id) => (await t.db.select().from(projects).where(eq(projects.id, id as number)))[0],
          update: (t, row) => t.db.update(projects).set({ name: "changed" }).where(eq(projects.id, row.id)),
          remove: (t, row) => t.db.delete(projects).where(eq(projects.id, row.id)),
        },
        invoices: {
          create: async (t) => {
            const [project] = await t.db.insert(projects).values({ slug: slug(), name: "For invoices" }).returning();
            return (await t.db.insert(invoices).values({ projectId: project!.id, amount: 10 }).returning())[0];
          },
          list: (t) => t.table(invoices).findMany(),
          update: (t, row) => t.table(invoices).update({ amount: 0 }, { where: eq(invoices.id, row.id) }),
        },
      },
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => `${c.resource}:${c.operation}`)).toEqual([
      "guard:organization",
      "guard:organization",
      "projects:create",
      "projects:read",
      "projects:read",
      "projects:get",
      "projects:update",
      "projects:delete",
      "invoices:create",
      "invoices:read",
      "invoices:read",
      "invoices:update",
    ]);
    expect(report.organizations[0].principal.organization?.code).toBe("org_acme");
    expect(report.organizations[0].token.split(".")).toHaveLength(3);
  });

  it("fails and names each leak when code bypasses the guard", async () => {
    const error = await testIsolation(guard, {
      organizations,
      testkit,
      resources: {
        projects: {
          create: async (t) => (await t.db.insert(projects).values({ slug: slug(), name: "Isolation" }).returning())[0],
          list: () => leaky.select().from(projects),
          get: async (_t, id) => (await leaky.select().from(projects).where(eq(projects.id, id as number)))[0],
          update: (_t, row) => leaky.update(projects).set({ name: "changed" }).where(eq(projects.id, row.id)),
          remove: (_t, row) => leaky.delete(projects).where(eq(projects.id, row.id)),
        },
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantIsolationError);
    const failed = (error as TenantIsolationError).report.checks.filter((c) => !c.ok).map((c) => c.operation);
    expect(failed).toEqual(["read", "read", "get", "update", "delete"]);
    expect((error as Error).message).toMatch(/org_acme can see org_globex's record/);
  });

  it("reports a create that fails instead of testing nothing", async () => {
    const error = await testIsolation(guard, {
      organizations,
      testkit,
      permissions: ["projects:read"],
      resources: { projects: { create: async (t) => (await t.table(projects).insert({ slug: slug(), name: "x" }))[0], list: (t) => t.table(projects).findMany() } },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantIsolationError);
    expect((error as Error).message).toMatch(/projects create: Creating a record failed.*"projects:create"/);
  });
});
