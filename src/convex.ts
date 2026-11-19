import type {
  Auth,
  DocumentByInfo,
  DocumentByName,
  GenericDatabaseReader,
  GenericDatabaseWriter,
  GenericDataModel,
  GenericTableInfo,
  IndexNames,
  IndexRange,
  IndexRangeBuilder,
  NamedIndex,
  NamedTableInfo,
  Query,
  QueryInitializer,
  SchemaDefinition,
  TableNamesInDataModel,
  WithOptionalSystemFields,
  WithoutSystemFields,
} from "convex/server";
import type { GenericId } from "convex/values";
import { TenantGuardError } from "./errors.js";
import {
  createTenantGuard,
  type AuditEvent,
  type ScopeHooks,
  type SystemSession,
  type TenantAdapter,
  type TenantSession,
  type VerifyResult,
  type WithTenantOptions,
} from "./guard.js";
import type { Policies, TenantAction } from "./policies.js";
import { principalFromClaims, type KindePrincipal } from "./principal.js";

/** The parts of a Convex query or mutation ctx the guard uses. */
export interface ConvexCtx {
  db: GenericDatabaseReader<any>;
  auth: Auth;
}

type DataModelOf<Ctx extends ConvexCtx> = Ctx["db"] extends GenericDatabaseReader<infer DM> ? DM : GenericDataModel;

/** A document to insert, where the tenant field is optional because the guard sets it. */
export type TenantInsert<Value, Field extends string> = Omit<Value, Field> & Partial<Pick<Value, Field & keyof Value>>;

/** A query on a tenant table. withIndex() takes indexes that start with the tenant field, and the guard fills in that first field. */
export type TenantQueryInitializer<TableInfo extends GenericTableInfo> = Omit<QueryInitializer<TableInfo>, "withIndex"> & {
  withIndex<IndexName extends IndexNames<TableInfo>>(
    indexName: IndexName,
    indexRange?: (q: IndexRangeBuilder<DocumentByInfo<TableInfo>, NamedIndex<TableInfo, IndexName>, 1>) => IndexRange,
  ): Query<TableInfo>;
};

export interface TenantDatabaseReader<DM extends GenericDataModel> {
  get<Table extends TableNamesInDataModel<DM>>(table: Table, id: GenericId<Table>): Promise<DocumentByName<DM, Table> | null>;
  get<Table extends TableNamesInDataModel<DM>>(id: GenericId<Table>): Promise<DocumentByName<DM, Table> | null>;
  query<Table extends TableNamesInDataModel<DM>>(table: Table): TenantQueryInitializer<NamedTableInfo<DM, Table>>;
  normalizeId<Table extends TableNamesInDataModel<DM>>(table: Table, id: string): GenericId<Table> | null;
  readonly system: GenericDatabaseReader<DM>["system"];
}

export interface TenantDatabaseWriter<DM extends GenericDataModel, Field extends string> extends TenantDatabaseReader<DM> {
  insert<Table extends TableNamesInDataModel<DM>>(table: Table, value: TenantInsert<WithoutSystemFields<DocumentByName<DM, Table>>, Field>): Promise<GenericId<Table>>;
  patch<Table extends TableNamesInDataModel<DM>>(table: Table, id: GenericId<Table>, value: Partial<DocumentByName<DM, Table>>): Promise<void>;
  patch<Table extends TableNamesInDataModel<DM>>(id: GenericId<Table>, value: Partial<DocumentByName<DM, Table>>): Promise<void>;
  replace<Table extends TableNamesInDataModel<DM>>(table: Table, id: GenericId<Table>, value: TenantInsert<WithOptionalSystemFields<DocumentByName<DM, Table>>, Field>): Promise<void>;
  replace<Table extends TableNamesInDataModel<DM>>(id: GenericId<Table>, value: TenantInsert<WithOptionalSystemFields<DocumentByName<DM, Table>>, Field>): Promise<void>;
  delete<Table extends TableNamesInDataModel<DM>>(table: Table, id: GenericId<Table>): Promise<void>;
  delete(id: GenericId<TableNamesInDataModel<DM>>): Promise<void>;
}

/** The scoped database for a ctx: a writer in mutations, a reader in queries. */
export type TenantDatabase<Ctx extends ConvexCtx, Field extends string> = Ctx["db"] extends GenericDatabaseWriter<any>
  ? TenantDatabaseWriter<DataModelOf<Ctx>, Field>
  : TenantDatabaseReader<DataModelOf<Ctx>>;

export interface ConvexTenantGuardOptions<Field extends string> {
  /** Your schema from convex/schema.ts. The guard reads its indexes to check that every tenant table can be scoped. */
  schema: SchemaDefinition<any, any>;
  /** The tables that belong to a tenant. Each one needs the tenant field and an index that starts with it. */
  tables: readonly string[];
  /** The field that holds the tenant ID on every tenant table, such as "tenantId". */
  tenantField: Field;
  /** Tables every tenant may read, such as plans. A tenant scope cannot write to them. */
  shared?: readonly string[];
  /**
   * Maps the verified Kinde organization code to your tenant ID. It gets the unscoped ctx, so it
   * can look the organization up. Return null when the organization is unknown.
   */
  resolveTenant(ctx: ConvexCtx, organizationCode: string, principal: KindePrincipal): Promise<string | null> | string | null;
  /** The permission each action on each table needs. Without policies, the guard checks tenancy only. */
  policies?: Policies;
  /** Called for every refusal and every system access. */
  onAudit?(event: AuditEvent): void;
  /** Builds the principal for a ctx. Default: the claims of ctx.auth.getUserIdentity(). */
  principal?(ctx: ConvexCtx): Promise<KindePrincipal | null> | KindePrincipal | null;
}

export interface ConvexTenantGuard<Field extends string> {
  /** Runs fn with a database that only reaches the caller's active Kinde organization. */
  withTenant<Ctx extends ConvexCtx, T>(ctx: Ctx, fn: (tenant: TenantSession<{ db: TenantDatabase<Ctx, Field> }>) => Promise<T>, options?: WithTenantOptions): Promise<T>;
  /**
   * Runs fn with system access, for internal functions and crons. Needs a reason, and is audited.
   * With a tenantId the database is scoped to that tenant. Without one it is ctx.db.
   */
  withSystem<Ctx extends ConvexCtx, T>(ctx: Ctx, options: { reason: string; tenantId?: string; requestId?: string }, fn: (system: SystemSession<{ db: Ctx["db"] }>) => Promise<T>): Promise<T>;
  /** Reports how each tenant table is scoped. */
  verify(): Promise<VerifyResult>;
}

interface TableIndexes {
  /** Index names whose first field is the tenant field. */
  indexes: Set<string>;
  /** Search index names that filter on the tenant field. */
  searchIndexes: Set<string>;
  /** The index used when a query does not choose one. */
  fallback: string;
}

interface ExportedTable {
  indexes?: Array<{ indexDescriptor: string; fields: string[] }>;
  searchIndexes?: Array<{ indexDescriptor: string; filterFields?: string[] }>;
}

function readIndexes(schema: SchemaDefinition<any, any>, tables: readonly string[], field: string): Map<string, TableIndexes> {
  const defined = (schema as unknown as { tables: Record<string, { export?(): ExportedTable; " indexes"?(): ExportedTable["indexes"] }> }).tables ?? {};
  const result = new Map<string, TableIndexes>();
  for (const table of tables) {
    const definition = defined[table];
    if (!definition) throw new Error(`kinde-tenant-guard: the schema has no "${table}" table.`);
    let exported: ExportedTable;
    try {
      exported = definition.export ? definition.export() : { indexes: definition[" indexes"]?.() };
    } catch {
      exported = { indexes: definition[" indexes"]?.() };
    }
    const indexes = (exported.indexes ?? []).filter((index) => index.fields[0] === field).map((index) => index.indexDescriptor);
    if (indexes.length === 0) {
      throw new Error(`kinde-tenant-guard: the "${table}" table needs an index that starts with "${field}", such as .index("by_${field}", ["${field}"]).`);
    }
    const searchIndexes = (exported.searchIndexes ?? []).filter((index) => index.filterFields?.includes(field)).map((index) => index.indexDescriptor);
    result.set(table, { indexes: new Set(indexes), searchIndexes: new Set(searchIndexes), fallback: indexes[0]! });
  }
  return result;
}

type AnyDb = Record<string, any>;
type AnyId = GenericId<string>;

function scopedDatabase(raw: AnyDb, tenantId: string, hooks: ScopeHooks, field: string, tables: Map<string, TableIndexes>, shared: Set<string>, isOpen: () => boolean): AnyDb {
  const deny = (code: TenantGuardError["code"], message: string): never => {
    throw hooks.deny(new TenantGuardError(code, message));
  };
  const open = () => {
    if (!isOpen()) deny("UNSAFE_QUERY", "This tenant database was used after its scope ended. Use it only inside the withTenant() callback.");
  };
  const known = (table: string, action: TenantAction) => {
    if (tables.has(table)) return "tenant" as const;
    if (shared.has(table)) {
      if (action !== "read") deny("FORBIDDEN", `"${table}" is shared by all tenants, so a tenant scope cannot ${action} it. Use withSystem().`);
      return "shared" as const;
    }
    return deny("UNSCOPED_TABLE", `The "${table}" table is not registered with convexTenantGuard(), so it cannot be used in a tenant scope.`);
  };
  const tableOfId = (id: string): string => {
    for (const table of [...tables.keys(), ...shared]) {
      if (raw.normalizeId(table, id) !== null) return table;
    }
    return deny("UNSCOPED_TABLE", "The document ID does not belong to a table registered with convexTenantGuard().");
  };
  // Mutations take (table, id, ...) or the older (id, ...). A registered table name is never a valid ID.
  const split = (args: unknown[], arity: number): { table: string; id: AnyId; rest: unknown[] } => {
    if (args.length > arity) return { table: String(args[0]), id: args[1] as AnyId, rest: args.slice(2) };
    return { table: tableOfId(String(args[0])), id: args[0] as AnyId, rest: args.slice(1) };
  };
  const owned = async (table: string, id: AnyId) => {
    const doc = await raw.get(table, id);
    if (doc && doc[field] !== tenantId) deny("CROSS_TENANT_WRITE", `The ${table} document ${String(id)} belongs to another tenant.`);
    return doc;
  };
  const stamped = (table: string, value: Record<string, unknown>, verb: string) => {
    if (value[field] !== undefined && value[field] !== tenantId) deny("CROSS_TENANT_WRITE", `The ${table} document names another tenant in "${field}", so it cannot be ${verb}.`);
    return { ...value, [field]: tenantId };
  };

  function query(table: string) {
    open();
    if (known(table, "read") === "shared") {
      hooks.authorize(table, "read");
      return raw.query(table);
    }
    hooks.authorize(table, "read");
    const info = tables.get(table)!;
    const initial = raw.query(table);
    const scopedTo = (name: string, range?: (q: any) => any) =>
      initial.withIndex(name, (q: any) => {
        const scoped = q.eq(field, tenantId);
        return range ? range(scoped) : scoped;
      });
    let fallback: AnyDb | undefined;
    const defaultQuery = () => (fallback ??= scopedTo(info.fallback));
    const methods: AnyDb = {
      withIndex(name: string, range?: (q: any) => any) {
        if (!info.indexes.has(name)) {
          deny("UNSAFE_QUERY", `The "${name}" index on "${table}" does not start with "${field}", so it can read other tenants' documents. Use one of: ${[...info.indexes].join(", ")}.`);
        }
        return scopedTo(name, range);
      },
      withSearchIndex(name: string, search: (q: any) => any) {
        if (!info.searchIndexes.has(name)) {
          deny("UNSAFE_QUERY", `The "${name}" search index on "${table}" does not list "${field}" in filterFields, so it can read other tenants' documents.`);
        }
        return initial.withSearchIndex(name, (q: any) => search(q).eq(field, tenantId));
      },
      fullTableScan: () => defaultQuery(),
    };
    return new Proxy(methods, {
      get(target, prop) {
        if (prop in target) return target[prop as string];
        const value = defaultQuery()[prop as string];
        return typeof value === "function" ? value.bind(defaultQuery()) : value;
      },
    });
  }

  async function get(...args: unknown[]) {
    open();
    const { table, id } = split(args, 1);
    known(table, "read");
    hooks.authorize(table, "read");
    const doc = await raw.get(table, id);
    if (doc && tables.has(table) && doc[field] !== tenantId) return null;
    return doc;
  }

  async function insert(table: string, value: Record<string, unknown>) {
    open();
    known(table, "create");
    hooks.authorize(table, "create");
    return raw.insert(table, stamped(table, value, "inserted"));
  }

  async function patch(...args: unknown[]) {
    open();
    const { table, id, rest } = split(args, 2);
    known(table, "update");
    hooks.authorize(table, "update");
    const value = rest[0] as Record<string, unknown>;
    if (field in value && value[field] !== tenantId) deny("CROSS_TENANT_WRITE", `A patch cannot move the ${table} document ${String(id)} to another tenant.`);
    await owned(table, id);
    return raw.patch(table, id, value);
  }

  async function replace(...args: unknown[]) {
    open();
    const { table, id, rest } = split(args, 2);
    known(table, "update");
    hooks.authorize(table, "update");
    const value = stamped(table, rest[0] as Record<string, unknown>, "written");
    await owned(table, id);
    return raw.replace(table, id, value);
  }

  async function remove(...args: unknown[]) {
    open();
    const { table, id } = split(args, 1);
    known(table, "delete");
    hooks.authorize(table, "delete");
    await owned(table, id);
    return raw.delete(table, id);
  }

  const writer = typeof raw.insert === "function";
  const refuseWrite = () => deny("UNSAFE_QUERY", "This is a query, so its database is read-only.");
  return {
    get,
    query,
    normalizeId: (table: string, id: string) => raw.normalizeId(table, id),
    get system() {
      return raw.system;
    },
    table: (table: string) => ({
      get: (id: AnyId) => get(table, id),
      query: () => query(table),
      insert: (value: Record<string, unknown>) => (writer ? insert(table, value) : refuseWrite()),
      patch: (id: AnyId, value: unknown) => (writer ? patch(table, id, value) : refuseWrite()),
      replace: (id: AnyId, value: unknown) => (writer ? replace(table, id, value) : refuseWrite()),
      delete: (id: AnyId) => (writer ? remove(table, id) : refuseWrite()),
    }),
    ...(writer ? { insert, patch, replace, delete: remove, vars: raw.vars } : {}),
  };
}

/** Creates a guard that scopes Convex queries and mutations to the caller's active Kinde organization. */
export function convexTenantGuard<const Field extends string>(options: ConvexTenantGuardOptions<Field>): ConvexTenantGuard<Field> {
  const field = options.tenantField;
  const tables = readIndexes(options.schema, options.tables, field);
  const shared = new Set(options.shared ?? []);
  for (const table of shared) {
    if (tables.has(table)) throw new Error(`kinde-tenant-guard: "${table}" is listed as both a tenant table and a shared table.`);
  }

  function adapterFor(ctx: ConvexCtx): TenantAdapter<{ db: AnyDb }> {
    const raw = ctx.db as unknown as AnyDb;
    const scoped = async <T>(tenantId: string, hooks: ScopeHooks, fn: (scope: { db: AnyDb }) => Promise<T>) => {
      let active = true;
      try {
        return await fn({ db: scopedDatabase(raw, tenantId, hooks, field, tables, shared, () => active) });
      } finally {
        active = false;
      }
    };
    return {
      name: "convex",
      run: (context, hooks, fn) => scoped(context.tenantId, hooks, fn),
      runSystem: (context, hooks, fn) => (context.tenantId ? scoped(context.tenantId, hooks, fn) : fn({ db: raw })),
    };
  }

  function guardFor(ctx: ConvexCtx) {
    return createTenantGuard({
      adapter: adapterFor(ctx),
      resolveTenant: (organizationCode, principal) => options.resolveTenant(ctx, organizationCode, principal),
      policies: options.policies,
      onAudit: options.onAudit,
    });
  }

  return {
    async withTenant(ctx, fn, withOptions) {
      const principal = options.principal ? await options.principal(ctx) : principalFromClaims((await ctx.auth.getUserIdentity()) ?? {});
      return guardFor(ctx).withTenant(principal ?? principalFromClaims({}), fn as never, withOptions);
    },
    async withSystem(ctx, systemOptions, fn) {
      return guardFor(ctx).withSystem(systemOptions, fn as never);
    },
    async verify() {
      return {
        ok: true,
        checks: [...tables].map(([table, info]) => ({
          name: table,
          ok: true,
          detail: `Scoped through ${[...info.indexes].join(", ")}${info.searchIndexes.size ? `; search through ${[...info.searchIndexes].join(", ")}` : ""}.`,
        })),
      };
    },
  };
}
