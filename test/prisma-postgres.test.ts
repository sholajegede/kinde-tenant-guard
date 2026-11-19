import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantGuard, isTenantGuardError, type AuditEvent } from "../src/index.js";
import { prismaAdapter } from "../src/prisma.js";
import { PrismaClient } from "./prisma/generated/client.js";
import { ownerPool, policies, principal, resetDatabase } from "./setup.js";

const connection = (user: string, password: string | undefined) =>
  new PrismaClient({
    adapter: new PrismaPg({ host: "127.0.0.1", port: Number(process.env.TENANT_GUARD_TEST_PORT), database: "tg_test", user, password, max: 4 }),
  });

const owner = ownerPool();
const prisma = connection("tg_app", "app");
const audit: AuditEvent[] = [];
const adapter = prismaAdapter(prisma, { models: { projects: "Project", invoices: "Invoice" }, tenantField: "tenantId" });
const guard = createTenantGuard({
  adapter,
  policies,
  onAudit: (event) => audit.push(event),
  // Tenant is a global model, so it is read with the normal client, outside any tenant scope.
  resolveTenant: async (orgCode) => (await prisma.tenant.findUnique({ where: { kindeOrgCode: orgCode } }))?.id ?? null,
});

let acme: Awaited<ReturnType<typeof principal>>;
let globex: Awaited<ReturnType<typeof principal>>;

const refused = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Error & { code?: string };
  }
};

beforeAll(async () => {
  acme = await principal("org_acme");
  globex = await principal("org_globex");
});
beforeEach(async () => {
  audit.length = 0;
  await resetDatabase(owner, adapter.migrationSql());
  await guard.withTenant(acme, (t) =>
    t.db.project.create({ data: { slug: "acme-portal", name: "Customer portal", invoices: { create: [{ amount: 100 }, { amount: 250 }] } } }),
  );
  await guard.withTenant(globex, (t) => t.db.project.create({ data: { slug: "globex-billing", name: "Billing revamp", invoices: { create: { amount: 9000 } } } }));
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

describe("Prisma with PostgreSQL row-level security", () => {
  it("stamps nested creates through the column default", async () => {
    const rows = await guard.withSystem({ reason: "test assertion" }, (s) => s.db.invoice.findMany({ orderBy: { id: "asc" } }));
    expect(rows.map((r) => r.tenantId)).toEqual(["t_acme", "t_acme", "t_globex"]);
  });

  it("findMany with no where, counts, aggregates and groupBy only see the tenant", async () => {
    const result = await guard.withTenant(acme, async (t) => ({
      projects: (await t.db.project.findMany()).map((p) => p.slug),
      count: await t.db.invoice.count(),
      sum: (await t.db.invoice.aggregate({ _sum: { amount: true } }))._sum.amount,
      groups: await t.db.invoice.groupBy({ by: ["tenantId"], _count: true }),
    }));
    expect(result).toEqual({ projects: ["acme-portal"], count: 2, sum: 350, groups: [{ tenantId: "t_acme", _count: 2 }] });
  });

  it("nested reads with include stay inside the tenant", async () => {
    const globexProjectId = (await guard.withTenant(globex, (t) => t.db.project.findFirst()))!.id;
    const nested = await guard.withTenant(acme, async (t) => ({
      own: await t.db.project.findMany({ include: { invoices: true } }),
      other: await t.db.project.findUnique({ where: { id: globexProjectId }, include: { invoices: true } }),
    }));
    expect(nested.own.flatMap((p) => p.invoices.map((i) => i.tenantId))).toEqual(["t_acme", "t_acme"]);
    expect(nested.other).toBeNull();
  });

  it("refuses a create that names another tenant", async () => {
    const error = await refused(guard.withTenant(acme, (t) => t.db.project.create({ data: { slug: "x", name: "x", tenantId: "t_globex" } })));
    expect(isTenantGuardError(error, "CROSS_TENANT_WRITE")).toBe(true);
    expect(audit.at(-1)).toMatchObject({ type: "access.denied", code: "CROSS_TENANT_WRITE" });
  });

  it("cannot update, move or delete another tenant's rows", async () => {
    const globexProject = (await guard.withTenant(globex, (t) => t.db.project.findFirst()))!;
    await guard.withTenant(acme, async (t) => {
      expect(isTenantGuardError(await refused(t.db.project.updateMany({ data: { tenantId: "t_globex" } })), "CROSS_TENANT_WRITE")).toBe(true);
      expect((await t.db.project.updateMany({ where: { id: globexProject.id }, data: { name: "taken" } })).count).toBe(0);
      expect(await refused(t.db.project.update({ where: { id: globexProject.id }, data: { name: "taken" } }))).not.toBeNull();
      expect(await refused(t.db.project.delete({ where: { id: globexProject.id } }))).not.toBeNull();
      expect(isTenantGuardError(await refused(t.db.project.findMany({ where: { tenantId: "t_globex" } })), "CROSS_TENANT_WRITE")).toBe(true);
    });
    expect((await guard.withTenant(globex, (t) => t.db.project.findFirst()))!.name).toBe("Billing revamp");
  });

  it("deleteMany with no filter only deletes the tenant's rows", async () => {
    // The shared policies allow no delete on invoices, so this guard checks tenancy only.
    const plain = createTenantGuard({ adapter, resolveTenant: (code) => (code === "org_acme" ? "t_acme" : null) });
    await plain.withTenant(acme, (t) => t.db.invoice.deleteMany());
    const left = await guard.withSystem({ reason: "test assertion" }, (s) => s.db.invoice.findMany());
    expect(left.map((r) => r.tenantId)).toEqual(["t_globex"]);
  });

  it("an upsert cannot take over another tenant's row", async () => {
    // Prisma runs this as INSERT ... ON CONFLICT DO UPDATE with the tenant filter, so the other
    // tenant's row does not match and nothing changes. Either way, the row is not taken over.
    await refused(
      guard.withTenant(acme, (t) => t.db.project.upsert({ where: { slug: "globex-billing" }, create: { slug: "globex-billing", name: "taken" }, update: { name: "taken" } })),
    );
    expect((await guard.withTenant(globex, (t) => t.db.project.findFirst()))!).toMatchObject({ name: "Billing revamp", tenantId: "t_globex" });
    expect((await guard.withTenant(acme, (t) => t.db.project.findMany())).map((p) => p.slug)).toEqual(["acme-portal"]);
  });

  it("raw SQL is limited by row-level security", async () => {
    const rows = await guard.withTenant(globex, (t) => t.db.$queryRaw<Array<{ slug: string }>>`select slug from projects`);
    expect(rows.map((r) => r.slug)).toEqual(["globex-billing"]);
  });

  it("checks permissions from the policies on every model operation", async () => {
    const viewer = await principal("org_acme", ["projects:read"]);
    await guard.withTenant(viewer, async (t) => {
      expect(await t.db.project.findMany()).toHaveLength(1);
      expect(isTenantGuardError(await refused(t.db.project.deleteMany()), "FORBIDDEN")).toBe(true);
      expect(isTenantGuardError(await refused(t.db.invoice.findMany()), "FORBIDDEN")).toBe(true);
    });
  });

  it("concurrent requests from two organizations never mix", async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        guard.withTenant(i % 2 ? globex : acme, async (t) => {
          await t.db.$executeRawUnsafe(`select pg_sleep(${(i % 5) / 100})`);
          return (await t.db.project.findMany()).map((p) => p.tenantId);
        }),
      ),
    );
    results.forEach((ids, i) => expect(new Set(ids)).toEqual(new Set([i % 2 ? "t_globex" : "t_acme"])));
  });

  it("the guarded client refuses to work outside a scope", async () => {
    const escaped = await guard.withTenant(acme, async (t) => t.db);
    expect(isTenantGuardError(await refused(escaped.project.findMany()), "UNSAFE_QUERY")).toBe(true);
  });

  it("withSystem for one tenant reaches only that tenant", async () => {
    const rows = await guard.withSystem({ reason: "per-tenant job", tenantId: "t_globex" }, (s) => s.db.project.findMany());
    expect(rows.map((r) => r.tenantId)).toEqual(["t_globex"]);
  });

  it("verify() passes for the app role and fails for a superuser", async () => {
    expect((await guard.verify()).ok).toBe(true);
    const root = connection("postgres", process.env.TENANT_GUARD_TEST_PASSWORD);
    try {
      const rootGuard = createTenantGuard({ adapter: prismaAdapter(root, { models: { projects: "Project" }, tenantField: "tenantId" }), resolveTenant: () => null });
      expect((await rootGuard.verify()).checks[0]).toMatchObject({ ok: false, detail: expect.stringContaining("superuser") });
    } finally {
      await root.$disconnect();
    }
  });

  it("generates the same policy SQL as the Drizzle adapter", () => {
    expect(adapter.migrationSql()).toContain(`CREATE POLICY tenant_guard_isolation ON "public"."invoices" FOR ALL USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::text`);
  });

  it("refuses a model without the tenant field", () => {
    expect(() => prismaAdapter(prisma, { models: { tenants: "Tenant" }, tenantField: "tenantId" })).toThrow(/no "tenantId" field/);
    expect(() => prismaAdapter(prisma, { models: { x: "Missing" }, tenantField: "tenantId" })).toThrow(/no "Missing" model/);
  });
});
