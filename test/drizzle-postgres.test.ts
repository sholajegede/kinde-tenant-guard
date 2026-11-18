import { count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isTenantGuardError, type AuditEvent } from "../src/index.js";
import { tenantRlsSql } from "../src/drizzle.js";
import { invoices, projects, schema } from "./schema.js";
import { appPool, makeGuard, ownerPool, principal, resetDatabase, type Db } from "./setup.js";

const owner = ownerPool();
const app = appPool();
const db: Db = drizzle(app, { schema });
const audit: AuditEvent[] = [];
const { guard, adapter } = makeGuard(db, audit);

let acme: Awaited<ReturnType<typeof principal>>;
let globex: Awaited<ReturnType<typeof principal>>;

async function seed() {
  await resetDatabase(owner, adapter.migrationSql());
  await guard.withTenant(acme, async (t) => {
    const [p] = await t.db.insert(projects).values({ slug: "acme-portal", name: "Customer portal" }).returning();
    await t.db.insert(invoices).values([{ projectId: p!.id, amount: 100 }, { projectId: p!.id, amount: 250 }]);
  });
  await guard.withTenant(globex, async (t) => {
    const [p] = await t.db.insert(projects).values({ slug: "globex-billing", name: "Billing revamp" }).returning();
    await t.db.insert(invoices).values({ projectId: p!.id, amount: 9000 });
  });
}

beforeAll(async () => {
  acme = await principal("org_acme");
  globex = await principal("org_globex");
});
beforeEach(async () => {
  audit.length = 0;
  await seed();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

const refusedBy = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as Error & { code?: string };
  }
};

describe("PostgreSQL row-level security through tenant.db", () => {
  it("a select with no where clause returns only the tenant's rows", async () => {
    const rows = await guard.withTenant(acme, (t) => t.db.select().from(projects));
    expect(rows.map((r) => r.slug)).toEqual(["acme-portal"]);
    expect(rows[0]!.tenantId).toBe("t_acme");
  });

  it("stamps inserts with the tenant through the column default", async () => {
    const [row] = await guard.withTenant(globex, (t) => t.db.insert(projects).values({ slug: "globex-new", name: "New" }).returning());
    expect(row!.tenantId).toBe("t_globex");
  });

  it("refuses an insert that names another tenant", async () => {
    const error = await refusedBy(guard.withTenant(acme, (t) => t.db.insert(projects).values({ tenantId: "t_globex", slug: "sneaky", name: "x" })));
    expect(String((error as { cause?: Error })?.cause?.message ?? error?.message)).toMatch(/row-level security/);
  });

  it("cannot move a row to another tenant, or update another tenant's rows", async () => {
    const move = await refusedBy(guard.withTenant(acme, (t) => t.db.update(projects).set({ tenantId: "t_globex" })));
    expect(String((move as { cause?: Error })?.cause?.message ?? move?.message)).toMatch(/row-level security/);
    const updated = await guard.withTenant(acme, (t) => t.db.update(projects).set({ name: "hijacked" }).where(eq(projects.slug, "globex-billing")).returning());
    expect(updated).toEqual([]);
  });

  it("a delete with no filter removes only the tenant's rows", async () => {
    await guard.withTenant(acme, async (t) => {
      await t.db.delete(invoices);
    });
    const remaining = await guard.withSystem({ reason: "test assertion" }, (s) => s.db.select().from(invoices));
    expect(remaining.map((r) => r.tenantId)).toEqual(["t_globex"]);
  });

  it("an upsert cannot take over another tenant's row", async () => {
    const error = await refusedBy(
      guard.withTenant(acme, (t) =>
        t.db.insert(projects).values({ slug: "globex-billing", name: "taken" }).onConflictDoUpdate({ target: projects.slug, set: { name: "taken" } }),
      ),
    );
    expect(error).not.toBeNull();
    const [globexProject] = await guard.withTenant(globex, (t) => t.db.select().from(projects));
    expect(globexProject!.name).toBe("Billing revamp");
  });

  it("joins, counts and relational queries stay inside the tenant", async () => {
    const result = await guard.withTenant(acme, async (t) => ({
      joined: await t.db.select({ amount: invoices.amount, project: projects.slug }).from(invoices).innerJoin(projects, eq(invoices.projectId, projects.id)),
      total: await t.db.select({ n: count() }).from(invoices),
      nested: await t.db.query.projects.findMany({ with: { invoices: true } }),
    }));
    expect(result.joined.map((r) => r.project)).toEqual(["acme-portal", "acme-portal"]);
    expect(result.total[0]!.n).toBe(2);
    expect(result.nested.flatMap((p) => p.invoices.map((i) => i.tenantId))).toEqual(["t_acme", "t_acme"]);
  });

  it("an acme invoice cannot point at a globex project through a foreign key read", async () => {
    const globexProjectId = (await guard.withTenant(globex, (t) => t.db.select().from(projects)))[0]!.id;
    const related = await guard.withTenant(acme, (t) => t.db.query.invoices.findMany({ where: eq(invoices.projectId, globexProjectId), with: { project: true } }));
    expect(related).toEqual([]);
  });

  it("raw SQL and prepared statements are limited too", async () => {
    const result = await guard.withTenant(globex, async (t) => {
      const raw = await t.db.execute(sql`select slug from projects`);
      const prepared = t.db.select().from(projects).where(sql`true`).prepare("all_projects");
      return { raw: raw.rows.map((r) => r.slug), prepared: (await prepared.execute()).map((r) => r.slug) };
    });
    expect(result).toEqual({ raw: ["globex-billing"], prepared: ["globex-billing"] });
  });

  it("keeps the tenant inside nested transactions and savepoints", async () => {
    const slugs = await guard.withTenant(acme, (t) => t.db.transaction(async (inner) => (await inner.select().from(projects)).map((r) => r.slug)));
    expect(slugs).toEqual(["acme-portal"]);
  });

  it("concurrent requests from different organizations never see each other's rows", async () => {
    const work = Array.from({ length: 24 }, (_, i) => {
      const who = i % 2 === 0 ? acme : globex;
      return guard.withTenant(who, async (t) => {
        await t.db.execute(sql`select pg_sleep(${(i % 5) / 100})`);
        return (await t.db.select().from(projects)).map((r) => r.tenantId);
      });
    });
    const results = await Promise.all(work);
    results.forEach((tenantIds, i) => expect(new Set(tenantIds)).toEqual(new Set([i % 2 === 0 ? "t_acme" : "t_globex"])));
  });

  it("a pooled connection keeps no tenant after the request, so unguarded queries see nothing", async () => {
    for (let i = 0; i < 8; i++) await guard.withTenant(i % 2 ? acme : globex, (t) => t.db.select().from(projects));
    const leaked = await Promise.all(Array.from({ length: 8 }, () => db.select().from(projects)));
    expect(leaked.flat()).toEqual([]);
  });
});

describe("the guard's own checks", () => {
  it("refuses a token without an active organization", async () => {
    const error = await refusedBy(guard.withTenant(await principal(null), (t) => t.db.select().from(projects)));
    expect(isTenantGuardError(error, "NO_ORGANIZATION")).toBe(true);
  });

  it("refuses an organization with no tenant mapping", async () => {
    const error = await refusedBy(guard.withTenant(await principal("org_initech"), (t) => t.db.select().from(projects)));
    expect(isTenantGuardError(error, "UNKNOWN_TENANT")).toBe(true);
    expect(audit.at(-1)).toMatchObject({ type: "access.denied", code: "UNKNOWN_TENANT", organizationCode: "org_initech" });
  });

  it("a request parameter cannot pick another organization", async () => {
    const error = await refusedBy(guard.withTenant(acme, (t) => t.db.select().from(projects), { organizationCode: "org_globex" }));
    expect(isTenantGuardError(error, "ORGANIZATION_MISMATCH")).toBe(true);
  });

  it("belonging to other organizations (org_codes) does not grant them", async () => {
    const member = await principal("org_acme", undefined, { org_codes: ["org_acme", "org_globex"] });
    const rows = await guard.withTenant(member, (t) => t.db.select().from(projects));
    expect(rows.map((r) => r.tenantId)).toEqual(["t_acme"]);
  });

  it("refuses a principal that was not built from a verified token", async () => {
    const error = await refusedBy(guard.withTenant({ ...acme, subject: "" }, (t) => t.db.select().from(projects)));
    expect(isTenantGuardError(error, "INVALID_PRINCIPAL")).toBe(true);
  });

  it("the context is frozen", async () => {
    await guard.withTenant(acme, async (t) => {
      expect(() => ((t.context as { tenantId: string }).tenantId = "t_globex")).toThrow();
    });
  });
});

describe("background jobs", () => {
  it("withSystem needs a reason and is audited", async () => {
    const error = await refusedBy(guard.withSystem({ reason: "" }, (s) => s.db.select().from(projects)));
    expect(isTenantGuardError(error, "SYSTEM_REASON_REQUIRED")).toBe(true);
    const all = await guard.withSystem({ reason: "nightly export" }, (s) => s.db.select().from(projects));
    expect(all).toHaveLength(2);
    expect(audit.at(-1)).toMatchObject({ type: "system.access", reason: "nightly export", tenantId: null });
  });

  it("withSystem for one tenant reaches only that tenant", async () => {
    const rows = await guard.withSystem({ reason: "per-tenant cleanup", tenantId: "t_globex" }, (s) => s.db.select().from(projects));
    expect(rows.map((r) => r.tenantId)).toEqual(["t_globex"]);
  });
});

describe("migration SQL", () => {
  it("enables and forces row-level security with the tenant policy and default", () => {
    const text = tenantRlsSql({ projects }, "tenantId");
    expect(text).toContain('ALTER TABLE "public"."projects" FORCE ROW LEVEL SECURITY;');
    expect(text).toContain(`CREATE POLICY tenant_guard_isolation ON "public"."projects" FOR ALL USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::text`);
    expect(text).toContain(`ALTER COLUMN "tenant_id" SET DEFAULT NULLIF(current_setting('app.tenant_id', true), '')::text;`);
  });
});

