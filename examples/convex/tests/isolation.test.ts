import { convexTest } from "convex-test";
import { testIsolation, type IsolationOrganization } from "kinde-tenant-guard/testing";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");

it("keeps two Kinde organizations apart", async () => {
  const t = convexTest(schema, modules);
  const as = (org: IsolationOrganization) => t.withIdentity(org.identity);
  const organizations: [string, string] = ["org_acme", "org_globex"];

  const report = await testIsolation({
    organizations,
    permissions: ["projects:read", "projects:create", "projects:delete"],
    resources: {
      projects: {
        create: async (org) => {
          await as(org).mutation(api.tenants.ensure, {});
          const id = await as(org).mutation(api.projects.create, { name: `Isolation ${org.code}` });
          return { _id: id };
        },
        list: (org) => as(org).query(api.projects.list, {}),
        remove: (org, row) => as(org).mutation(api.projects.remove, { id: row._id }),
      },
    },
  });
  expect(report.ok).toBe(true);
});

it("refuses a user without the permission", async () => {
  const t = convexTest(schema, modules);
  const reader = t.withIdentity({ subject: "kp_reader", issuer: "https://example.kinde.com", org_code: "org_acme", permissions: ["projects:read"] });
  await reader.mutation(api.tenants.ensure, {});
  await expect(reader.mutation(api.projects.create, { name: "Nope" })).rejects.toThrow(/projects:create/);
});
