# Changelog

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
