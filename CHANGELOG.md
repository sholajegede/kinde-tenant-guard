# Changelog

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
