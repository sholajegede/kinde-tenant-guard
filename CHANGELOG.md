# Changelog

## 0.5.0

- Add the `kinde-tenant-guard check` command. It finds database access outside the guard, tenant tables and models the guard does not cover, registered tables without the tenant field, and Convex tenant tables without a tenant index. With `--database-url`, it also checks row-level security in the live database. `--json` prints the report for CI and coding agents, and it exits with 1 on an error.
- Add `checkProject()` in `kinde-tenant-guard/check`, the same check from code.
- The ESLint rule and the command share one detector, so they flag the same code.
- Node 20.19 or later is now required, for the parser the command uses.

## 0.4.0

- Add `testIsolation()` in `kinde-tenant-guard/testing`. It mints a token for two organizations with kinde-testkit, creates a record as each, and checks reads, reads by ID, updates and deletes across the boundary. It throws a `TenantIsolationError` that names each leak. Without a guard it calls your app through convex-test or HTTP.
- Add the ESLint plugin in `kinde-tenant-guard/eslint`, with the `no-unguarded-db` rule. It flags calls on the raw database client and `ctx.db` in Convex functions outside the guard's setup.
- Add `defineTenantTools()` in `kinde-tenant-guard/agents`. Agent tools run in their own tenant scope for the signed-in principal, check their permission first, and refuse input that names a tenant or organization.
- Add `guard.can(principal, resource, action)`, `guard.policies`, and `tenant.deny(error)` for audited refusals of your own.
- Add the `UNSAFE_TOOL_INPUT` error code.

## 0.3.0

- Add the Convex adapter, `kinde-tenant-guard/convex`. `convexTenantGuard()` wraps `ctx.db` in queries and mutations so every read on a tenant table goes through an index that starts with the tenant field, inserts are stamped with the tenant, and writes to another tenant's documents are refused.
- Search indexes are scoped when they list the tenant field in `filterFields`. Other indexes and search indexes are refused.
- Shared tables can be read from a tenant scope but not written. Unregistered tables are refused.
- The guard reads the Convex schema at startup and throws if a tenant table has no index on the tenant field.
- `principalFromClaims()` accepts a Convex `UserIdentity`, which names the subject and issuer `subject` and `issuer`.
- The core no longer imports `node:crypto`, so it runs in the Convex runtime and other edge runtimes.

## 0.2.0

- Add the Prisma adapter, `kinde-tenant-guard/prisma`, for Prisma 7. A query extension adds the tenant to every operation on the registered models, stamps creates and upserts, refuses data that names another tenant, and checks the policy for each operation. On PostgreSQL each scope runs in one interactive transaction with the tenant set, so row-level security also limits nested reads and raw SQL.
- Without row-level security, the Prisma adapter refuses relation reads and nested writes to tenant models, and raw SQL, because it cannot limit them.
- The guarded Prisma client refuses to run after its `withTenant()` scope has finished.
- Add the `UNSAFE_QUERY` error code.
- The PostgreSQL policy SQL and startup checks are shared by both adapters.

## 0.1.0

First release.

- `createTenantGuard()` with `withTenant()`, `withSystem()`, `verify()` and `assertSafe()`.
- Principals from verified Kinde claims or tokens with `principalFromClaims()` and `verifyKindeToken()`, including machine-to-machine tokens. Only `org_code` becomes the active organization.
- Fail-closed tenant resolution: no organization, an unknown organization, or a request that names another organization is refused.
- Permission policies with `required`, `global` and `system` resources.
- Audit events for every refusal and every system access.
- Drizzle adapter with PostgreSQL row-level security: a transaction-local tenant setting, generated policy SQL, tenant stamping through a column default, and a startup check for roles and policies.
- Scoped table helpers for SQLite, MySQL and PostgreSQL without row-level security.
- Tests against a real PostgreSQL server, including concurrent requests on pooled connections, and against SQLite.
