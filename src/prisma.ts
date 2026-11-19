import { AsyncLocalStorage } from "node:async_hooks";
import { TenantGuardError } from "./errors.js";
import type { ScopeHooks, SystemContext, TenantAdapter, TenantContext, VerifyResult } from "./guard.js";
import type { TenantAction } from "./policies.js";
import { rlsSql, SYSTEM_SETTING, TENANT_SETTING, verifyPostgres, type PostgresTenantTable } from "./postgres.js";

export { POLICY_NAME, SYSTEM_SETTING, TENANT_SETTING } from "./postgres.js";

/** The column default that stamps new rows with the transaction's tenant, for @default(dbgenerated(...)). */
export const TENANT_DEFAULT_SQL = `NULLIF(current_setting('${TENANT_SETTING}', true), '')`;

// The parts of a Prisma 7 client the adapter uses. Prisma's own types are generated per schema, so
// the adapter keeps the client's type as given and only describes what it calls.
interface PrismaLike {
  $extends(extension: unknown): unknown;
}
interface RuntimeModel {
  dbName: string | null;
  schema: string | null;
  fields: Array<{ name: string; kind: string; type: string; dbName?: string }>;
}

export interface PrismaAdapterOptions {
  /** Your tenant models by the resource name your policies use, such as { projects: "Project" }. */
  models: Record<string, string>;
  /** The tenant field on every tenant model, such as "tenantId". */
  tenantField: string;
  /** Use PostgreSQL row-level security as the boundary. On by default when the client uses PostgreSQL. */
  rls?: boolean;
  /** The SQL type of the tenant column, for the generated policy. Default: text. */
  tenantColumnType?: string;
  /** Options for the interactive transaction each scope runs in, such as { timeout: 15000 }. Prisma's default timeout is 5 seconds. */
  transactionOptions?: { maxWait?: number; timeout?: number; isolationLevel?: string };
}

export interface PrismaScope<Client> {
  /**
   * A Prisma client for this tenant. Queries on the registered models are filtered by the tenant,
   * creates are stamped, and moving rows to another tenant is refused. With row-level security it
   * runs in one transaction, so PostgreSQL also limits nested reads and raw SQL.
   */
  readonly db: Client;
}

export interface PrismaTenantAdapter<Client> extends TenantAdapter<PrismaScope<Client>> {
  readonly rls: boolean;
  /** The SQL that turns on row-level security for the registered models. Put it in a migration. */
  migrationSql(): string;
}

interface Active {
  tenantId: string | null;
  hooks: ScopeHooks;
}

const READS = new Set(["findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy"]);
const UNIQUE_WHERE = new Set(["findUnique", "findUniqueOrThrow", "update", "delete", "upsert"]);
const LIST_WHERE = new Set(["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy", "updateMany", "updateManyAndReturn", "deleteMany"]);

function actionOf(operation: string): TenantAction | null {
  if (READS.has(operation)) return "read";
  if (operation.startsWith("create")) return "create";
  if (operation.startsWith("update")) return "update";
  if (operation.startsWith("delete")) return "delete";
  return null;
}

/** Wraps a Prisma client so every tenant scope reaches only one tenant's rows. */
export function prismaAdapter<Client extends PrismaLike>(prisma: Client, options: PrismaAdapterOptions): PrismaTenantAdapter<Client> {
  const internals = prisma as unknown as { _activeProvider?: string; _runtimeDataModel?: { models: Record<string, RuntimeModel> } };
  const provider = internals._activeProvider ?? "unknown";
  const dataModel = internals._runtimeDataModel?.models ?? {};
  const postgres = provider === "postgresql" || provider === "postgres";
  const rls = options.rls ?? postgres;
  if (rls && !postgres) throw new Error(`kinde-tenant-guard: row-level security needs PostgreSQL, but this Prisma client uses ${provider}. Pass rls: false.`);

  const field = options.tenantField;
  const resources = new Map<string, string>();
  for (const [resource, model] of Object.entries(options.models)) {
    const definition = dataModel[model];
    if (!definition) throw new Error(`kinde-tenant-guard: the Prisma client has no "${model}" model.`);
    if (!definition.fields.some((f) => f.name === field && f.kind === "scalar")) {
      throw new Error(`kinde-tenant-guard: the "${model}" model has no "${field}" field.`);
    }
    resources.set(model, resource);
  }
  // Relation fields that lead to a tenant model, per model. Without row-level security, reading or
  // writing through them would skip the tenant filter, so they are refused.
  const tenantRelations = new Map<string, Set<string>>();
  for (const [model, definition] of Object.entries(dataModel)) {
    tenantRelations.set(model, new Set(definition.fields.filter((f) => f.kind === "object" && resources.has(f.type)).map((f) => f.name)));
  }

  const storage = new AsyncLocalStorage<Active>();

  function refuse(active: Active, code: TenantGuardError["code"], message: string): never {
    throw active.hooks.deny(new TenantGuardError(code, message));
  }

  function checkNested(active: Active, model: string, args: Record<string, unknown>) {
    const relations = tenantRelations.get(model);
    if (!relations || relations.size === 0) return;
    for (const key of ["include", "select"]) {
      const shape = args[key] as Record<string, unknown> | undefined;
      if (!shape) continue;
      for (const [name, value] of Object.entries(shape)) {
        if (value && relations.has(name)) {
          refuse(active, "UNSAFE_QUERY", `Reading "${model}.${name}" through ${key} is not limited to the tenant without row-level security. Query that model on its own.`);
        }
      }
    }
    const data = args.data as Record<string, unknown> | Array<Record<string, unknown>> | undefined;
    for (const row of Array.isArray(data) ? data : data ? [data] : []) {
      for (const name of Object.keys(row)) {
        if (relations.has(name)) refuse(active, "UNSAFE_QUERY", `A nested write to "${model}.${name}" is not limited to the tenant without row-level security. Write that model on its own.`);
      }
    }
  }

  function scopeArgs(active: Active, model: string, operation: string, input: Record<string, unknown> | undefined) {
    const args: Record<string, unknown> = { ...(input ?? {}) };
    const tenantId = active.tenantId;
    const resource = resources.get(model)!;

    const stamp = (row: Record<string, unknown>) => {
      const given = row[field];
      if (tenantId === null) {
        if (given === undefined || given === null) refuse(active, "CROSS_TENANT_WRITE", `A system create on "${model}" must set "${field}" itself.`);
        return row;
      }
      if (given !== undefined && given !== tenantId) refuse(active, "CROSS_TENANT_WRITE", `A create on "${model}" tried to set "${field}" to another tenant.`);
      return { ...row, [field]: tenantId };
    };
    const keep = (row: Record<string, unknown> | undefined) => {
      if (row && field in row && (tenantId === null || row[field] !== tenantId)) {
        refuse(active, "CROSS_TENANT_WRITE", `An update on "${model}" tried to move rows to another tenant.`);
      }
      return row;
    };

    if (operation === "create") args.data = stamp((args.data ?? {}) as Record<string, unknown>);
    if (operation === "createMany" || operation === "createManyAndReturn") {
      args.data = (Array.isArray(args.data) ? args.data : [args.data]).map((row) => stamp(row as Record<string, unknown>));
    }
    if (operation === "update" || operation === "updateMany" || operation === "updateManyAndReturn") keep(args.data as Record<string, unknown>);
    if (operation === "upsert") {
      args.create = stamp((args.create ?? {}) as Record<string, unknown>);
      keep(args.update as Record<string, unknown>);
    }

    if (tenantId !== null) {
      const where = args.where as Record<string, unknown> | undefined;
      if (where && field in where && where[field] !== tenantId) {
        refuse(active, "CROSS_TENANT_WRITE", `A query on "${model}" asked for another tenant's rows.`);
      }
      if (UNIQUE_WHERE.has(operation)) args.where = { ...(where ?? {}), [field]: tenantId };
      else if (LIST_WHERE.has(operation)) args.where = where ? { AND: [where, { [field]: tenantId }] } : { [field]: tenantId };
    }

    const action = actionOf(operation);
    if (action) active.hooks.authorize(resource, action);
    if (operation === "upsert") active.hooks.authorize(resource, "create");
    return args;
  }

  const guarded = prisma.$extends({
    name: "kinde-tenant-guard",
    query: {
      async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: Record<string, unknown>; query: (args: unknown) => Promise<unknown> }) {
        const active = storage.getStore();
        if (!active) {
          throw new TenantGuardError("UNSAFE_QUERY", "This client only works inside tenantGuard.withTenant() or withSystem().");
        }
        if (!model) {
          // Raw SQL. With row-level security PostgreSQL limits it. Without, nothing can.
          if (!rls && operation.startsWith("$")) refuse(active, "UNSAFE_QUERY", `${operation} cannot be limited to the tenant without row-level security.`);
          return query(args);
        }
        if (!rls) checkNested(active, model, args ?? {});
        if (!resources.has(model)) return query(args);
        return query(scopeArgs(active, model, operation, args));
      },
    },
  }) as Client & {
    $transaction<T>(fn: (tx: Client & { $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number> }) => Promise<T>, options?: unknown): Promise<T>;
  };

  async function open<T>(active: Active, settings: Array<[string, string]>, fn: (scope: PrismaScope<Client>) => Promise<T>): Promise<T> {
    return storage.run(active, async () => {
      if (!rls) return fn({ db: guarded });
      return guarded.$transaction(async (tx) => {
        // The third argument makes each setting local to this transaction, so a pooled connection
        // never carries one request's tenant into the next.
        for (const [key, value] of settings) await tx.$executeRawUnsafe("select set_config($1, $2, true)", key, value);
        return fn({ db: tx as unknown as Client });
      }, options.transactionOptions);
    });
  }

  const tables = (): PostgresTenantTable[] =>
    Object.entries(options.models).map(([resource, model]) => {
      const definition = dataModel[model]!;
      const column = definition.fields.find((f) => f.name === field)!;
      return { resource, schema: definition.schema ?? "public", name: definition.dbName ?? model, column: column.dbName ?? field, type: options.tenantColumnType ?? "text" };
    });

  return {
    name: "prisma",
    rls,
    run<T>(context: TenantContext, hooks: ScopeHooks, fn: (scope: PrismaScope<Client>) => Promise<T>) {
      return open({ tenantId: context.tenantId, hooks }, [[TENANT_SETTING, context.tenantId]], fn);
    },
    runSystem<T>(context: SystemContext, hooks: ScopeHooks, fn: (scope: PrismaScope<Client>) => Promise<T>) {
      const settings: Array<[string, string]> = context.tenantId ? [[TENANT_SETTING, context.tenantId]] : [[SYSTEM_SETTING, "on"]];
      return open({ tenantId: context.tenantId, hooks }, settings, fn);
    },
    migrationSql() {
      if (!rls) return "-- Row-level security is off for this adapter, so there is no SQL to run.\n";
      return rlsSql(tables());
    },
    async verify(): Promise<VerifyResult> {
      if (!rls) {
        return {
          ok: true,
          checks: [{ name: "row-level security", ok: true, detail: "Off. The adapter filters queries on the registered models and refuses raw SQL and nested relation access." }],
        };
      }
      const raw = prisma as unknown as { $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<Record<string, unknown>[]> };
      return verifyPostgres((text, params) => raw.$queryRawUnsafe(text, ...params), tables());
    },
  };
}
