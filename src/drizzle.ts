import { and, eq, getTableName, is, sql, Table, type InferInsertModel, type InferSelectModel, type SQL } from "drizzle-orm";
import { getTableConfig, PgDatabase, PgTable, text } from "drizzle-orm/pg-core";
import { TenantGuardError } from "./errors.js";
import type { ScopeHooks, SystemContext, TenantAdapter, TenantContext, VerifyCheck, VerifyResult } from "./guard.js";

/** The PostgreSQL setting that holds the active tenant for the current transaction. */
export const TENANT_SETTING = "app.tenant_id";
/** The PostgreSQL setting withSystem() turns on to reach every tenant. */
export const SYSTEM_SETTING = "app.tenant_guard_system";
/** The name of the policy the generated SQL creates on each table. */
export const POLICY_NAME = "tenant_guard_isolation";

const currentTenant = (cast: string) => `NULLIF(current_setting('${TENANT_SETTING}', true), '')::${cast}`;

/**
 * A text column that defaults to the transaction's tenant, so inserts made through the guard are
 * stamped by the database itself: tenantId: tenantIdColumn().
 */
export function tenantIdColumn(name = "tenant_id") {
  return text(name)
    .notNull()
    .default(sql.raw(currentTenant("text")));
}

// Any Drizzle database: node-postgres, postgres.js, Neon, PGlite, SQLite or MySQL.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDatabase = { transaction: (...args: any[]) => any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxOf<DB> = DB extends { transaction: (fn: (tx: infer TX) => any, ...rest: any[]) => any } ? TX : DB;

/** An insert row where the tenant column is optional, because the guard stamps it. */
type InsertOf<T> = T extends { $inferInsert: infer I } ? I : never;
export type TenantInsert<T extends Table, C extends string> = Omit<InsertOf<T>, C> & Partial<Pick<InsertOf<T>, Extract<keyof InsertOf<T>, C>>>;

export interface DrizzleAdapterOptions<Tables extends Record<string, Table>, C extends string = string> {
  /** The tables that belong to tenants, by the resource name your policies use. */
  tables: Tables;
  /** The property name of the tenant column on every table, such as "tenantId". */
  tenantColumn: C;
  /**
   * Use PostgreSQL row-level security as the boundary. On by default for PostgreSQL. With it off,
   * or on SQLite and MySQL, only the scoped table helpers are available.
   */
  rls?: boolean;
}

export interface FindOptions {
  where?: SQL;
  orderBy?: SQL | SQL[];
  limit?: number;
  offset?: number;
}

/** Tenant-scoped operations on one table. Every call is filtered by, and stamped with, the tenant. */
export interface ScopedTable<T extends Table, C extends string = string> {
  findMany(options?: FindOptions): Promise<InferSelectModel<T>[]>;
  findFirst(options?: Omit<FindOptions, "limit">): Promise<InferSelectModel<T> | null>;
  count(options?: { where?: SQL }): Promise<number>;
  /** Inserts with the tenant stamped. A row that names another tenant is refused. */
  insert(values: TenantInsert<T, C> | TenantInsert<T, C>[]): Promise<InferSelectModel<T>[]>;
  /** Updates the tenant's rows. Changing the tenant column is refused. */
  update(set: Partial<InferInsertModel<T>>, options?: { where?: SQL }): Promise<InferSelectModel<T>[]>;
  delete(options?: { where?: SQL }): Promise<InferSelectModel<T>[]>;
}

export interface DrizzleScope<DB, C extends string = string> {
  /**
   * The Drizzle transaction, with the tenant set for PostgreSQL row-level security. Every query on
   * it, including joins, relational queries and raw SQL, sees only this tenant's rows. Only
   * available with row-level security.
   */
  readonly db: TxOf<DB>;
  /** Scoped operations on a registered table, with the permission check from your policies. */
  table<T extends Table>(table: T): ScopedTable<T, C>;
}

export interface DrizzleTenantAdapter<DB, Tables extends Record<string, Table>, C extends string = string> extends TenantAdapter<DrizzleScope<DB, C>> {
  readonly tables: Tables;
  readonly rls: boolean;
  /** The SQL that turns on row-level security for the registered tables. Put it in a migration. */
  migrationSql(): string;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function qualifiedName(table: Table): { schema: string; name: string; sql: string } {
  const config = is(table, PgTable) ? getTableConfig(table) : null;
  const schema = config?.schema ?? "public";
  const name = getTableName(table);
  return { schema, name, sql: `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"` };
}

/** Wraps a Drizzle database so every tenant scope reaches only one tenant's rows. */
export function drizzleAdapter<DB extends AnyDatabase, const Tables extends Record<string, Table>, const C extends string>(
  db: DB,
  options: DrizzleAdapterOptions<Tables, C>,
): DrizzleTenantAdapter<DB, Tables, C> {
  const postgres = is(db, PgDatabase);
  const rls = options.rls ?? postgres;
  if (rls && !postgres) throw new Error("kinde-tenant-guard: row-level security needs a PostgreSQL Drizzle database. Pass rls: false for SQLite or MySQL.");

  const names = new Map<Table, string>();
  for (const [name, table] of Object.entries(options.tables)) {
    const column = (table as unknown as Record<string, unknown>)[options.tenantColumn];
    if (!column || typeof (column as { name?: unknown }).name !== "string") {
      throw new Error(`kinde-tenant-guard: the "${name}" table has no "${options.tenantColumn}" column.`);
    }
    names.set(table, name);
  }
  const tenantColumnOf = (table: Table) => (table as unknown as Record<string, unknown>)[options.tenantColumn] as Parameters<typeof eq>[0] & { name: string; getSQLType(): string };

  function scopedTable<T extends Table>(executor: AnyDatabase, table: T, tenantId: string | null, hooks: ScopeHooks): ScopedTable<T, C> {
    const name = names.get(table);
    if (!name) {
      throw hooks.deny(new TenantGuardError("UNSCOPED_TABLE", `The "${getTableName(table)}" table is not registered with drizzleAdapter(), so it cannot be used in a tenant scope.`));
    }
    const column = tenantColumnOf(table);
    const q = executor as unknown as Record<string, (...args: unknown[]) => any>;
    const filter = (where?: SQL) => (tenantId === null ? where : where ? and(eq(column, tenantId), where) : eq(column, tenantId));
    const returning = (builder: any) => (typeof builder.returning === "function" ? builder.returning() : builder.then((r: unknown) => rowsOf(r)));

    const stamp = (row: Record<string, unknown>) => {
      const given = row[options.tenantColumn];
      if (tenantId === null) {
        if (given === undefined || given === null) {
          throw hooks.deny(new TenantGuardError("CROSS_TENANT_WRITE", `A system insert into "${name}" must set "${options.tenantColumn}" itself.`));
        }
        return row;
      }
      if (given !== undefined && given !== tenantId) {
        throw hooks.deny(new TenantGuardError("CROSS_TENANT_WRITE", `An insert into "${name}" tried to set "${options.tenantColumn}" to another tenant.`));
      }
      return { ...row, [options.tenantColumn]: tenantId };
    };

    return {
      async findMany(find = {}) {
        hooks.authorize(name, "read");
        let query = q.select!().from(table).$dynamic();
        const where = filter(find.where);
        if (where) query = query.where(where);
        if (find.orderBy) query = query.orderBy(...(Array.isArray(find.orderBy) ? find.orderBy : [find.orderBy]));
        if (find.limit !== undefined) query = query.limit(find.limit);
        if (find.offset !== undefined) query = query.offset(find.offset);
        return query;
      },
      async findFirst(find = {}) {
        const rows = await this.findMany({ ...find, limit: 1 });
        return rows[0] ?? null;
      },
      async count(find = {}) {
        hooks.authorize(name, "read");
        let query = q.select!({ count: sql<number>`count(*)` }).from(table).$dynamic();
        const where = filter(find.where);
        if (where) query = query.where(where);
        const [row] = await query;
        return Number(row?.count ?? 0);
      },
      async insert(values) {
        hooks.authorize(name, "create");
        const rows = (Array.isArray(values) ? values : [values]).map((row) => stamp(row as unknown as Record<string, unknown>));
        if (rows.length === 0) return [];
        return returning(q.insert!(table).values(rows));
      },
      async update(set, find = {}) {
        hooks.authorize(name, "update");
        const changes = { ...(set as Record<string, unknown>) };
        if (options.tenantColumn in changes) {
          if (tenantId === null || changes[options.tenantColumn] !== tenantId) {
            throw hooks.deny(new TenantGuardError("CROSS_TENANT_WRITE", `An update on "${name}" tried to move rows to another tenant.`));
          }
          delete changes[options.tenantColumn];
        }
        let query = q.update!(table).set(changes).$dynamic();
        const where = filter(find.where);
        if (where) query = query.where(where);
        return returning(query);
      },
      async delete(find = {}) {
        hooks.authorize(name, "delete");
        let query = q.delete!(table).$dynamic();
        const where = filter(find.where);
        if (where) query = query.where(where);
        return returning(query);
      },
    };
  }

  const unavailableDb = new Proxy(
    {},
    {
      get() {
        throw new Error(
          "kinde-tenant-guard: tenant.db needs PostgreSQL row-level security, because without it a query on the raw database is not limited to the tenant. Use tenant.table(...) instead.",
        );
      },
    },
  );

  function scope(executor: AnyDatabase, tenantId: string | null, hooks: ScopeHooks): DrizzleScope<DB, C> {
    return {
      db: (rls ? executor : unavailableDb) as TxOf<DB>,
      table: <T extends Table>(table: T) => scopedTable(executor, table, tenantId, hooks),
    };
  }

  async function inTransaction<T>(settings: Array<[string, string]>, fn: (tx: AnyDatabase) => Promise<T>): Promise<T> {
    return (await db.transaction((async (tx: AnyDatabase & { execute(query: SQL): Promise<unknown> }) => {
      // The third argument makes each setting local to this transaction, so a pooled connection
      // never carries one request's tenant into the next.
      for (const [key, value] of settings) await tx.execute(sql`select set_config(${key}, ${value}, true)`);
      return fn(tx);
    }) as never)) as T;
  }

  return {
    name: "drizzle",
    tables: options.tables,
    rls,
    async run<T>(context: TenantContext, hooks: ScopeHooks, fn: (scope: DrizzleScope<DB, C>) => Promise<T>): Promise<T> {
      if (!rls) return fn(scope(db, context.tenantId, hooks));
      return inTransaction([[TENANT_SETTING, context.tenantId]], (tx) => fn(scope(tx, context.tenantId, hooks)));
    },
    async runSystem<T>(context: SystemContext, hooks: ScopeHooks, fn: (scope: DrizzleScope<DB, C>) => Promise<T>): Promise<T> {
      if (!rls) return fn(scope(db, context.tenantId, hooks));
      const settings: Array<[string, string]> = context.tenantId ? [[TENANT_SETTING, context.tenantId]] : [[SYSTEM_SETTING, "on"]];
      return inTransaction(settings, (tx) => fn(scope(tx, context.tenantId, hooks)));
    },
    migrationSql() {
      if (!rls) return "-- Row-level security is off for this adapter, so there is no SQL to run.\n";
      return tenantRlsSql(options.tables, options.tenantColumn);
    },
    async verify(): Promise<VerifyResult> {
      if (!rls) {
        return {
          ok: true,
          checks: [{ name: "row-level security", ok: true, detail: "Off. Only the scoped table helpers limit queries to the tenant, so do not use the database client directly for tenant data." }],
        };
      }
      const execute = (query: SQL) => (db as unknown as { execute(query: SQL): Promise<unknown> }).execute(query).then(rowsOf);
      const checks: VerifyCheck[] = [];
      const [role] = await execute(sql`select current_user as name, r.rolsuper as super, r.rolbypassrls as bypass from pg_roles r where r.rolname = current_user`);
      const bypasses = Boolean(role?.super) || Boolean(role?.bypass);
      checks.push({
        name: "database role",
        ok: !bypasses,
        detail: bypasses
          ? `The app connects as "${String(role?.name)}", which ${role?.super ? "is a superuser" : "has BYPASSRLS"}, so PostgreSQL skips row-level security on every query.`
          : `The app connects as "${String(role?.name)}", which row-level security applies to.`,
        ...(bypasses ? { fix: `Connect as a role without SUPERUSER or BYPASSRLS, for example: CREATE ROLE app_user LOGIN PASSWORD '...'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;` } : {}),
      });
      for (const [resource, table] of Object.entries(options.tables)) {
        const { schema, name, sql: qualified } = qualifiedName(table);
        const [state] = await execute(sql`select c.relrowsecurity as enabled, c.relforcerowsecurity as forced from pg_class c where c.oid = to_regclass(${qualified})`);
        const [policy] = await execute(sql`select count(*)::int as count from pg_policies where schemaname = ${schema} and tablename = ${name} and policyname = ${POLICY_NAME}`);
        const ok = Boolean(state?.enabled) && Boolean(state?.forced) && Number(policy?.count) > 0;
        checks.push({
          name: `${resource} (${schema}.${name})`,
          ok,
          detail: !state
            ? "The table does not exist."
            : ok
              ? "Row-level security is enabled and forced, with the tenant policy."
              : `Row-level security is ${state.enabled ? "enabled" : "not enabled"}, ${state.forced ? "forced" : "not forced"}, and the ${POLICY_NAME} policy is ${Number(policy?.count) > 0 ? "present" : "missing"}.`,
          ...(ok ? {} : { fix: "Run the SQL from adapter.migrationSql() in a migration." }),
        });
      }
      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/** The SQL that enables, forces and adds the tenant policy on each table, and stamps new rows with the tenant. */
export function tenantRlsSql(tables: Record<string, Table>, tenantColumn: string): string {
  const parts = ["-- Generated by kinde-tenant-guard. Each tenant table only shows and accepts rows for the tenant in app.tenant_id."];
  for (const [resource, table] of Object.entries(tables)) {
    const { sql: qualified } = qualifiedName(table);
    const column = (table as unknown as Record<string, { name: string; getSQLType(): string }>)[tenantColumn];
    if (!column) throw new Error(`kinde-tenant-guard: the "${resource}" table has no "${tenantColumn}" column.`);
    const col = `"${column.name.replace(/"/g, '""')}"`;
    const cast = column.getSQLType();
    const rule = `${col} = ${currentTenant(cast)} OR current_setting('${SYSTEM_SETTING}', true) = 'on'`;
    parts.push(
      [
        `-- ${resource}`,
        `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
        `ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY;`,
        `DROP POLICY IF EXISTS ${POLICY_NAME} ON ${qualified};`,
        `CREATE POLICY ${POLICY_NAME} ON ${qualified} FOR ALL USING (${rule}) WITH CHECK (${rule});`,
        `ALTER TABLE ${qualified} ALTER COLUMN ${col} SET DEFAULT ${currentTenant(cast)};`,
      ].join("\n"),
    );
  }
  return `${parts.join("\n\n")}\n`;
}
