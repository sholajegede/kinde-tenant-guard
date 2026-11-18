import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { startKindeTestkit, type RunningKindeTestkit } from "kinde-testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTenantGuard, isTenantGuardError, principalFromClaims, verifyKindeToken, type AuditEvent } from "../src/index.js";
import { drizzleAdapter } from "../src/drizzle.js";
import { invoices, projects, schema } from "./schema.js";
import { appPool, makeGuard, ownerPool, principal, resetDatabase, superPool, type Db } from "./setup.js";

const owner = ownerPool();
const app = appPool();
const root = superPool();
const db: Db = drizzle(app, { schema });
const audit: AuditEvent[] = [];
const { guard, adapter } = makeGuard(db, audit);
// The scoped helpers also work without row-level security, for SQLite and MySQL.
const scopedOnly = makeGuard(drizzle(app, { schema }), [], false);

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Error;
  }
};

beforeEach(async () => {
  audit.length = 0;
  await resetDatabase(owner, adapter.migrationSql());
});
afterAll(async () => {
  await Promise.all([app.end(), owner.end(), root.end()]);
});

describe("scoped table helpers", () => {
  it("filter reads, stamp inserts and refuse cross-tenant writes", async () => {
    const acme = await principal("org_acme");
    await guard.withTenant(acme, async (t) => {
      const [created] = await t.table(projects).insert({ slug: "acme-a", name: "A" });
      expect(created!.tenantId).toBe("t_acme");
      expect(await t.table(projects).count()).toBe(1);
      expect(await t.table(projects).findFirst({ where: eq(projects.slug, "acme-a") })).toMatchObject({ name: "A" });
      expect(isTenantGuardError(await refusal(t.table(projects).insert({ slug: "x", name: "x", tenantId: "t_globex" })), "CROSS_TENANT_WRITE")).toBe(true);
      expect(isTenantGuardError(await refusal(t.table(projects).update({ tenantId: "t_globex" })), "CROSS_TENANT_WRITE")).toBe(true);
      expect(await t.table(projects).update({ name: "A2" }, { where: eq(projects.slug, "acme-a") })).toHaveLength(1);
    });
    expect(audit.filter((e) => e.type === "access.denied").map((e) => (e as { code: string }).code)).toEqual(["CROSS_TENANT_WRITE", "CROSS_TENANT_WRITE"]);
  });

  it("check the permission each action needs", async () => {
    const viewer = await principal("org_acme", ["projects:read"]);
    await guard.withTenant(viewer, async (t) => {
      expect(t.can("projects", "read")).toBe(true);
      expect(t.can("projects", "delete")).toBe(false);
      await t.table(projects).findMany();
      expect(isTenantGuardError(await refusal(t.table(projects).delete()), "FORBIDDEN")).toBe(true);
      expect(isTenantGuardError(await refusal(t.table(projects).insert({ slug: "v", name: "v" })), "FORBIDDEN")).toBe(true);
      // invoices has no update action in its policy, so nobody may update invoices.
      expect(() => t.authorize("invoices", "update")).toThrow(/allows no "update"/);
      expect(() => t.authorize("reports", "read")).toThrow(/No policy covers "reports"/);
    });
  });

  it("refuse a table that is not registered with the adapter", async () => {
    const notes = pgTable("notes", { id: serial("id").primaryKey(), tenantId: text("tenant_id").notNull(), body: text("body").notNull() });
    const error = await refusal(guard.withTenant(await principal("org_acme"), async (t) => t.table(notes).findMany()));
    expect(isTenantGuardError(error, "UNSCOPED_TABLE")).toBe(true);
  });

  it("isolate tenants without row-level security, and keep tenant.db closed", async () => {
    await owner.query("ALTER TABLE projects DISABLE ROW LEVEL SECURITY; ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;");
    const acme = await principal("org_acme");
    const globex = await principal("org_globex");
    await scopedOnly.guard.withTenant(acme, (t) => t.table(projects).insert({ slug: "acme-s", name: "S" }));
    await scopedOnly.guard.withTenant(globex, (t) => t.table(projects).insert({ slug: "globex-s", name: "S" }));
    await scopedOnly.guard.withTenant(acme, async (t) => {
      expect((await t.table(projects).findMany()).map((r) => r.slug)).toEqual(["acme-s"]);
      expect(await t.table(projects).delete()).toHaveLength(1);
      expect(() => t.db.select()).toThrow(/needs PostgreSQL row-level security/);
    });
    const globexLeft = await scopedOnly.guard.withTenant(globex, (t) => t.table(projects).findMany());
    expect(globexLeft.map((r) => r.slug)).toEqual(["globex-s"]);
  });
});

describe("verify()", () => {
  it("passes for an app role with row-level security on every table", async () => {
    const result = await guard.verify();
    expect(result.ok).toBe(true);
    await guard.assertSafe();
  });

  it("fails for a superuser connection, which skips row-level security", async () => {
    const unsafe = drizzle(root, { schema });
    const { guard: rootGuard } = makeGuard(unsafe);
    const result = await rootGuard.verify();
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ name: "database role", ok: false, detail: expect.stringContaining("superuser") });
    await expect(rootGuard.assertSafe()).rejects.toThrow(/does not enforce tenant isolation/);

    // The reason it matters: an unguarded query through the superuser leaks every tenant.
    await guard.withTenant(await principal("org_acme"), (t) => t.db.insert(projects).values({ slug: "a", name: "a" }));
    await guard.withTenant(await principal("org_globex"), (t) => t.db.insert(projects).values({ slug: "g", name: "g" }));
    expect(await unsafe.select().from(projects)).toHaveLength(2);
    expect(await db.select().from(projects)).toHaveLength(0);
  });

  it("fails for a table without the policy", async () => {
    await owner.query("ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY; DROP POLICY tenant_guard_isolation ON invoices;");
    const result = await guard.verify();
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name.startsWith("invoices"))).toMatchObject({ ok: false, detail: expect.stringContaining("not forced") });
  });
});

describe("verifyKindeToken()", () => {
  let kinde: RunningKindeTestkit;
  beforeAll(async () => {
    kinde = await startKindeTestkit({ port: 0, audience: "https://api.example.test" });
  });
  afterAll(() => kinde.close());

  it("verifies a token against the issuer's JWKS and reads its organization", async () => {
    const token = await kinde.testkit.token({ subject: "kp_1", organizationCode: "org_acme", permissions: ["projects:read"] });
    const p = await verifyKindeToken(token, { issuer: kinde.issuer, audience: "https://api.example.test" });
    expect(p).toMatchObject({ type: "user", subject: "kp_1", organization: { code: "org_acme" }, permissions: ["projects:read"] });
  });

  it("refuses expired, forged and wrong-audience tokens", async () => {
    for (const invalid of ["expired", "bad-signature", "wrong-audience", "unsigned"] as const) {
      const token = await kinde.testkit.token({ subject: "kp_1", organizationCode: "org_acme", invalid });
      const error = await refusal(verifyKindeToken(token, { issuer: kinde.issuer, audience: "https://api.example.test" }));
      expect(isTenantGuardError(error, "INVALID_PRINCIPAL")).toBe(true);
    }
  });

  it("reads an M2M token as a machine principal", async () => {
    const token = await kinde.testkit.m2mToken({ clientId: "billing_worker", organizationCode: "org_acme", audience: ["https://api.example.test"] });
    expect(await verifyKindeToken(token, { issuer: kinde.issuer, audience: "https://api.example.test" })).toMatchObject({
      type: "machine",
      subject: "billing_worker",
      organization: { code: "org_acme" },
    });
  });
});

describe("principalFromClaims()", () => {
  it("accepts the Next.js SDK's KindeAccessToken, an interface without an index signature", () => {
    interface KindeAccessToken { sub: string; iss: string; org_code: string; org_codes: string[]; permissions: string[]; roles: { id: string; key: string; name: string }[] }
    const claims: KindeAccessToken = { sub: "kp_1", iss: "https://acme.kinde.com", org_code: "org_acme", org_codes: ["org_acme", "org_globex"], permissions: ["projects:read"], roles: [{ id: "r1", key: "admin", name: "Admin" }] };
    expect(principalFromClaims(claims)).toMatchObject({ type: "user", subject: "kp_1", organization: { code: "org_acme" }, roles: ["admin"], permissions: ["projects:read"] });
  });
});

describe("guard setup", () => {
  it("refuses a table without the tenant column", () => {
    const loose = pgTable("loose", { id: serial("id").primaryKey() });
    expect(() => drizzleAdapter(db, { tables: { loose }, tenantColumn: "tenantId" })).toThrow(/no "tenantId" column/);
  });

  it("works without policies, checking tenancy only", async () => {
    const plain = createTenantGuard({ adapter, resolveTenant: (code) => (code === "org_acme" ? "t_acme" : null) });
    await plain.withTenant(await principal("org_acme", []), async (t) => {
      expect(t.can("anything", "delete")).toBe(true);
      expect(await t.table(invoices).count()).toBe(0);
    });
  });
});
