import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineTenantTools } from "../src/agents.js";
import { isTenantGuardError, type AuditEvent } from "../src/index.js";
import { projects, schema } from "./schema.js";
import { appPool, makeGuard, ownerPool, principal, resetDatabase, type Db } from "./setup.js";

const owner = ownerPool();
const app = appPool();
const db: Db = drizzle(app, { schema });
const audit: AuditEvent[] = [];
const { guard, adapter } = makeGuard(db, audit);

const tools = defineTenantTools(guard, {
  listProjects: {
    resource: "projects",
    action: "read",
    description: "List the organization's projects.",
    run: async (t, _input: Record<string, never>) => (await t.db.select().from(projects)).map((p) => p.slug),
  },
  deleteProject: {
    resource: "projects",
    action: "delete",
    run: async (t, input: { id: number }) => (await t.db.delete(projects).where(eq(projects.id, input.id)).returning()).length,
  },
  renameProject: {
    resource: "projects",
    action: "update",
    run: async (t, input: { id: number; patch: { name: string } }) => (await t.db.update(projects).set(input.patch).where(eq(projects.id, input.id)).returning()).length,
  },
});

let acme: Awaited<ReturnType<typeof principal>>;
let reader: Awaited<ReturnType<typeof principal>>;
let globexProjectId: number;

beforeAll(async () => {
  acme = await principal("org_acme");
  reader = await principal("org_acme", ["projects:read"]);
});
beforeEach(async () => {
  audit.length = 0;
  await resetDatabase(owner, adapter.migrationSql());
  await guard.withTenant(acme, (t) => t.db.insert(projects).values({ slug: "acme-portal", name: "Portal" }));
  const globex = await principal("org_globex");
  globexProjectId = (await guard.withTenant(globex, (t) => t.db.insert(projects).values({ slug: "globex-billing", name: "Billing" }).returning()))[0]!.id;
});
afterAll(async () => {
  await Promise.all([app.end(), owner.end()]);
});

describe("defineTenantTools()", () => {
  it("offers only the tools the principal's permissions allow", () => {
    expect(tools.forPrincipal(acme).available.map((t) => t.name)).toEqual(["listProjects", "deleteProject", "renameProject"]);
    expect(tools.forPrincipal(reader).available.map((t) => t.name)).toEqual(["listProjects"]);
    expect(tools.forPrincipal(reader).available[0]).toMatchObject({ description: "List the organization's projects.", resource: "projects", action: "read" });
  });

  it("runs each call in the principal's tenant", async () => {
    expect(await tools.forPrincipal(acme).tools.listProjects.execute({})).toEqual(["acme-portal"]);
    expect(await tools.forPrincipal(acme).call("deleteProject", { id: globexProjectId })).toBe(0);
  });

  it("refuses a tool the principal may not use, and audits it", async () => {
    const error = await tools.forPrincipal(reader).tools.deleteProject.execute({ id: globexProjectId }).catch((e: unknown) => e);
    expect(isTenantGuardError(error, "FORBIDDEN")).toBe(true);
    expect(audit.at(-1)).toMatchObject({ type: "access.denied", code: "FORBIDDEN" });
  });

  it("refuses input that names a tenant or organization, at any depth", async () => {
    for (const input of [{ id: 1, tenantId: "t_globex" }, { id: 1, patch: { name: "x", ORG_CODE: "org_globex" } }]) {
      const error = await tools.forPrincipal(acme).call("renameProject", input).catch((e: unknown) => e);
      expect(isTenantGuardError(error, "UNSAFE_TOOL_INPUT")).toBe(true);
    }
    expect(audit.at(-1)).toMatchObject({ type: "access.denied", code: "UNSAFE_TOOL_INPUT" });
  });

  it("refuses unknown tool names", async () => {
    for (const name of ["dropDatabase", "toString", "__proto__"]) {
      expect(isTenantGuardError(await tools.forPrincipal(acme).call(name, {}).catch((e: unknown) => e), "UNSAFE_TOOL_INPUT")).toBe(true);
    }
  });

  it("refuses a principal with no active organization", async () => {
    const nobody = await principal(null);
    expect(tools.forPrincipal(nobody).available).toEqual([]);
    expect(isTenantGuardError(await tools.forPrincipal(nobody).call("listProjects", {}).catch((e: unknown) => e), "NO_ORGANIZATION")).toBe(true);
  });
});
