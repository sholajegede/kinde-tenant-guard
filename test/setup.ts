import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { scenario, KindeTestkit } from "kinde-testkit";
import pg from "pg";
import { createTenantGuard, definePolicies, principalFromClaims, type AuditEvent, type KindePrincipal } from "../src/index.js";
import { drizzleAdapter } from "../src/drizzle.js";
import { CREATE_TABLES, invoices, projects, schema, tenants } from "./schema.js";

const base = { host: "127.0.0.1", port: Number(process.env.TENANT_GUARD_TEST_PORT), database: "tg_test" };
export const ownerPool = () => new pg.Pool({ ...base, user: "tg_owner", password: "owner" });
export const appPool = () => new pg.Pool({ ...base, user: "tg_app", password: "app", max: 4 });
export const superPool = () => new pg.Pool({ ...base, user: "postgres", password: process.env.TENANT_GUARD_TEST_PASSWORD });

export type Db = NodePgDatabase<typeof schema>;

/** Creates the tables as their owner, then applies the generated row-level security SQL. */
export async function resetDatabase(owner: pg.Pool, migrationSql: string) {
  await owner.query(CREATE_TABLES);
  await owner.query(migrationSql);
}

export const policies = definePolicies({
  projects: { tenant: "required", permissions: { read: "projects:read", create: "projects:create", update: "projects:update", delete: "projects:delete" } },
  invoices: { tenant: "required", permissions: { read: "invoices:read", create: "invoices:create" } },
});

export function makeGuard(db: Db, audit: AuditEvent[] = [], rls?: boolean) {
  const adapter = drizzleAdapter(db, { tables: { projects, invoices }, tenantColumn: "tenantId", ...(rls === undefined ? {} : { rls }) });
  const guard = createTenantGuard({
    adapter,
    policies,
    onAudit: (event) => audit.push(event),
    // tenants is a global table, so it is read with the normal database, outside any tenant scope.
    resolveTenant: async (orgCode) => (await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.kindeOrgCode, orgCode)))[0]?.id ?? null,
  });
  return { guard, adapter };
}

const testkit = await KindeTestkit.create({ issuer: "https://acme.kinde.test", audience: "https://api.example.test" });
const everything = ["projects:read", "projects:create", "projects:update", "projects:delete", "invoices:read", "invoices:create"];

/** A principal built from a real Kinde-shaped access token, minted by kinde-testkit. */
export async function principal(org: string | null, permissions = everything, extra: Record<string, unknown> = {}): Promise<KindePrincipal> {
  let s = scenario().user({ email: `${org ?? "nobody"}@example.test` });
  s = org ? s.organization(org) : s.withoutOrganization();
  const token = (await testkit.tokenFor(s.permissions(permissions).claims(extra).authenticated()))!;
  return principalFromClaims(await testkit.verify(token));
}
