import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { VerifyResult } from "./guard.js";
import { verifyPostgres, type PostgresTenantTable } from "./postgres.js";
import { calleeName, createUnguardedChecker, keyName, unguardedMessage, type UnguardedOptions } from "./unguarded.js";

export type CheckRule =
  | "no-unguarded-db"
  | "unregistered-tenant-table"
  | "missing-tenant-column"
  | "missing-tenant-index"
  | "missing-tenant-default"
  | "unknown-table"
  | "parse-error";

export interface CheckFinding {
  rule: CheckRule;
  severity: "error" | "warning";
  /** The file, relative to the directory that was checked. */
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface CheckReport {
  /** False when there is at least one error, or a failed database check. */
  ok: boolean;
  /** How many files were read. */
  files: number;
  findings: CheckFinding[];
  /** The live database checks, when a database URL was given. */
  database?: VerifyResult;
}

export interface CheckOptions extends Pick<UnguardedOptions, "clients" | "convexContexts"> {
  /** The project directory. Default: the current directory. */
  cwd?: string;
  /** Files or directories to check, relative to cwd. Default: ["."]. */
  paths?: string[];
  /** Paths or globs to skip, relative to cwd, such as "scripts/**". */
  ignore?: string[];
  /** Check test files too. They are skipped by default, because tests often seed data with the raw client. */
  includeTests?: boolean;
  /** A PostgreSQL connection string. When given, the row-level security checks run against it. Needs the pg package. */
  databaseUrl?: string;
}

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".vercel", ".output", ".nuxt", ".svelte-kit", "coverage", "_generated"]);
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)(?:__tests__|__mocks__)\//;
const DRIZZLE_TABLES = new Set(["pgTable", "sqliteTable", "mysqlTable", "singlestoreTable"]);

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/^\.\//, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  // A plain path also matches everything inside it.
  return new RegExp(`^${pattern}(?:/.*)?$`);
}

async function listFiles(root: string, start: string, skip: (rel: string) => boolean, into: string[]) {
  const entries = await readdir(start, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    if (!skip(relative(root, start).split(sep).join("/"))) into.push(start);
    return;
  }
  for (const entry of entries) {
    const full = join(start, entry.name);
    const rel = relative(root, full).split(sep).join("/");
    if (skip(rel)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await listFiles(root, full, skip, into);
    } else if (entry.isFile() && (CODE.test(entry.name) || entry.name.endsWith(".prisma")) && !entry.name.endsWith(".d.ts")) {
      into.push(full);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

const CHILD_SKIP = new Set(["loc", "range", "start", "end", "extra", "comments", "leadingComments", "trailingComments", "innerComments", "tokens"]);

function walk(node: AnyNode, ancestors: AnyNode[], visit: (node: AnyNode, ancestors: AnyNode[]) => void) {
  visit(node, ancestors);
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (CHILD_SKIP.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") walk(child, ancestors, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, ancestors, visit);
    }
  }
  ancestors.pop();
}

const literal = (node: AnyNode): string | null => (node?.type === "Literal" && typeof node.value === "string" ? node.value : null);
const property = (object: AnyNode, name: string): AnyNode =>
  object?.type === "ObjectExpression" ? object.properties.find((p: AnyNode) => p.type === "Property" && keyName(p.key) === name)?.value : undefined;
const strings = (node: AnyNode): string[] => (node?.type === "ArrayExpression" ? node.elements.map(literal).filter((s: string | null): s is string => !!s) : []);

interface Where {
  file: string;
  line: number;
  column: number;
}
const at = (file: string, node: AnyNode): Where => ({ file, line: node?.loc?.start?.line ?? 1, column: (node?.loc?.start?.column ?? 0) + 1 });

interface DrizzleTable extends Where {
  variable: string;
  sqlName: string;
  schema: string;
  columns: Map<string, string>;
}
interface ConvexTable extends Where {
  name: string;
  fields: Set<string>;
  indexes: Array<{ name: string; fields: string[] }>;
}
interface PrismaModel extends Where {
  name: string;
  dbName: string;
  postgres: boolean;
  fields: Map<string, { dbName: string; line: number; attributes: string }>;
}

function disabledLines(comments: AnyNode[] = []): { all: boolean; lines: Set<number> } {
  const lines = new Set<number>();
  let all = false;
  for (const comment of comments) {
    const text = String(comment.value).trim();
    const match = /^eslint-disable(-next-line|-line)?\b(.*)$/.exec(text);
    if (!match) continue;
    const rules = match[2]!.split("--")[0]!.trim();
    if (rules && !rules.includes("no-unguarded-db")) continue;
    if (match[1] === "-next-line") lines.add(comment.loc.end.line + 1);
    else if (match[1] === "-line") lines.add(comment.loc.start.line);
    else all = true;
  }
  return { all, lines };
}

function parsePrisma(file: string, source: string, models: PrismaModel[]) {
  const postgres = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(?:postgresql|postgres)"/.test(source);
  const lines = source.split("\n");
  let current: PrismaModel | null = null;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const opening = /^model\s+(\w+)\s*\{/.exec(line);
    if (opening) {
      current = { file, line: index + 1, column: 1, name: opening[1]!, dbName: opening[1]!, postgres, fields: new Map() };
      models.push(current);
      return;
    }
    if (!current) return;
    if (line.startsWith("}")) {
      current = null;
      return;
    }
    const map = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
    if (map) {
      current.dbName = map[1]!;
      return;
    }
    const field = /^(\w+)\s+\S+(.*)$/.exec(line);
    if (field && !line.startsWith("@")) {
      const attributes = field[2] ?? "";
      const column = /@map\(\s*"([^"]+)"\s*\)/.exec(attributes);
      current.fields.set(field[1]!, { dbName: column?.[1] ?? field[1]!, line: index + 1, attributes });
    }
  });
}

/**
 * Checks a project for tenant isolation problems: database access outside the guard, tenant
 * tables the guard does not cover, and, with a database URL, row-level security in the live
 * database. Used by `npx kinde-tenant-guard check`.
 */
export async function checkProject(options: CheckOptions = {}): Promise<CheckReport> {
  const { parse } = await import("@babel/parser");
  const root = resolve(options.cwd ?? ".");
  const ignore = (options.ignore ?? []).map(globToRegExp);
  const skip = (rel: string) => (!!rel && ignore.some((re) => re.test(rel))) || (!options.includeTests && TEST_FILE.test(rel));
  const files: string[] = [];
  for (const path of options.paths?.length ? options.paths : ["."]) await listFiles(root, resolve(root, path), skip, files);

  const findings: CheckFinding[] = [];
  const add = (rule: CheckRule, severity: CheckFinding["severity"], where: Where, message: string) => findings.push({ rule, severity, ...where, message });
  const check = createUnguardedChecker({ clients: options.clients, convexContexts: options.convexContexts });

  const drizzleTables: DrizzleTable[] = [];
  const drizzleAdapters: Array<Where & { tables: Map<string, string>; tenantColumn: string }> = [];
  const prismaModels: PrismaModel[] = [];
  const prismaAdapters: Array<Where & { models: Map<string, string>; field: string }> = [];
  const convexTables: ConvexTable[] = [];
  const convexGuards: Array<Where & { tables: string[]; shared: string[]; field: string }> = [];

  for (const path of [...new Set(files)].sort()) {
    const file = relative(root, path).split(sep).join("/");
    const source = await readFile(path, "utf8");
    if (path.endsWith(".prisma")) {
      parsePrisma(file, source, prismaModels);
      continue;
    }
    let ast: AnyNode;
    try {
      ast = parse(source, {
        sourceType: "unambiguous",
        errorRecovery: true,
        plugins: ["estree", "jsx", ["typescript", { dts: false }], "decorators", "importAttributes"],
      } as never);
    } catch (error) {
      add("parse-error", "warning", { file, line: 1, column: 1 }, `The file could not be parsed, so it was not checked: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const disabled = disabledLines(ast.comments);

    walk(ast.program, [], (node, ancestors) => {
      const finding = disabled.all ? null : check(node, ancestors);
      if (finding && !disabled.lines.has(node.loc.start.line)) add("no-unguarded-db", "error", at(file, node), unguardedMessage(finding));

      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "CallExpression" && DRIZZLE_TABLES.has(calleeName(node.init.callee) ?? "")) {
        const [nameArg, columnsArg] = node.init.arguments;
        const sqlName = literal(nameArg);
        const columns = columnsArg?.type === "ArrowFunctionExpression" ? (columnsArg.body.type === "ObjectExpression" ? columnsArg.body : null) : columnsArg;
        if (sqlName && columns?.type === "ObjectExpression") {
          const map = new Map<string, string>();
          for (const p of columns.properties) {
            const key = p.type === "Property" ? keyName(p.key) : null;
            if (!key) continue;
            let call = p.value;
            while (call?.type === "CallExpression" && call.callee?.type === "MemberExpression" && call.callee.object?.type === "CallExpression") call = call.callee.object;
            const first = call?.type === "CallExpression" ? literal(call.arguments[0]) : null;
            map.set(key, first ?? (calleeName(call?.callee) === "tenantIdColumn" ? "tenant_id" : key));
          }
          drizzleTables.push({ ...at(file, node), variable: node.id.name, sqlName, schema: "public", columns: map });
        }
      }

      if (node.type !== "CallExpression") return;
      const name = calleeName(node.callee);
      const config = node.arguments[1];
      if (name === "drizzleAdapter" && config?.type === "ObjectExpression") {
        const tables = new Map<string, string>();
        const list = property(config, "tables");
        for (const p of list?.type === "ObjectExpression" ? list.properties : []) {
          if (p.type === "Property" && p.value?.type === "Identifier") tables.set(keyName(p.key) ?? p.value.name, p.value.name);
        }
        drizzleAdapters.push({ ...at(file, node), tables, tenantColumn: literal(property(config, "tenantColumn")) ?? "tenantId" });
      }
      if (name === "prismaAdapter" && config?.type === "ObjectExpression") {
        const models = new Map<string, string>();
        const list = property(config, "models");
        for (const p of list?.type === "ObjectExpression" ? list.properties : []) {
          const model = p.type === "Property" ? literal(p.value) : null;
          if (model) models.set(keyName(p.key) ?? model, model);
        }
        prismaAdapters.push({ ...at(file, node), models, field: literal(property(config, "tenantField")) ?? "tenantId" });
      }
      if (name === "convexTenantGuard" && node.arguments[0]?.type === "ObjectExpression") {
        const options = node.arguments[0];
        convexGuards.push({
          ...at(file, node),
          tables: strings(property(options, "tables")),
          shared: strings(property(options, "shared")),
          field: literal(property(options, "tenantField")) ?? "tenantId",
        });
      }
      if (name === "defineSchema" && node.arguments[0]?.type === "ObjectExpression") {
        for (const p of node.arguments[0].properties) {
          const table = p.type === "Property" ? keyName(p.key) : null;
          if (!table) continue;
          const indexes: ConvexTable["indexes"] = [];
          let chain = p.value;
          while (chain?.type === "CallExpression" && chain.callee?.type === "MemberExpression") {
            const method = keyName(chain.callee.property);
            const indexName = literal(chain.arguments[0]);
            if (method === "index" && indexName) {
              const spec = chain.arguments[1];
              indexes.push({ name: indexName, fields: spec?.type === "ArrayExpression" ? strings(spec) : strings(property(spec, "fields")) });
            }
            chain = chain.callee.object;
          }
          if (chain?.type !== "CallExpression" || calleeName(chain.callee) !== "defineTable") continue;
          let shape = chain.arguments[0];
          if (shape?.type === "CallExpression" && calleeName(shape.callee) === "object") shape = shape.arguments[0];
          const fields = new Set<string>(shape?.type === "ObjectExpression" ? shape.properties.map((f: AnyNode) => (f.type === "Property" ? keyName(f.key) : null)).filter(Boolean) : []);
          convexTables.push({ ...at(file, p), name: table, fields, indexes });
        }
      }
    });
  }

  // Drizzle: every table with the tenant column must be registered, and every registered table needs it.
  for (const adapter of drizzleAdapters) {
    const registered = new Set(adapter.tables.values());
    for (const variable of registered) {
      const table = drizzleTables.find((t) => t.variable === variable);
      if (!table) add("unknown-table", "warning", adapter, `drizzleAdapter() registers \`${variable}\`, but no pgTable(), sqliteTable() or mysqlTable() named \`${variable}\` was found, so it was not checked.`);
      else if (!table.columns.has(adapter.tenantColumn)) add("missing-tenant-column", "error", table, `The "${table.sqlName}" table is registered with drizzleAdapter() but has no "${adapter.tenantColumn}" column.`);
    }
  }
  if (drizzleAdapters.length) {
    const registered = new Set(drizzleAdapters.flatMap((a) => [...a.tables.values()]));
    const columns = new Set(drizzleAdapters.map((a) => a.tenantColumn));
    for (const table of drizzleTables) {
      const column = [...columns].find((c) => table.columns.has(c));
      if (column && !registered.has(table.variable)) {
        add("unregistered-tenant-table", "error", table, `The "${table.sqlName}" table has a "${column}" column but is not registered with drizzleAdapter(), so the guard does not protect it. Add \`${table.variable}\` to tables.`);
      }
    }
  }

  // Prisma: the same, plus the database default that stamps nested creates.
  for (const adapter of prismaAdapters) {
    for (const model of new Set(adapter.models.values())) {
      const found = prismaModels.find((m) => m.name === model);
      if (!found) add("unknown-table", "warning", adapter, `prismaAdapter() registers the "${model}" model, but no schema.prisma model by that name was found, so it was not checked.`);
      else if (!found.fields.has(adapter.field)) add("missing-tenant-column", "error", found, `The ${model} model is registered with prismaAdapter() but has no "${adapter.field}" field.`);
      else if (found.postgres && !/dbgenerated\([^)]*app\.tenant_id/.test(found.fields.get(adapter.field)!.attributes)) {
        add(
          "missing-tenant-default",
          "warning",
          { file: found.file, line: found.fields.get(adapter.field)!.line, column: 1 },
          `${model}.${adapter.field} has no @default(dbgenerated(...)) on app.tenant_id, so nested creates are not stamped by the database. Use TENANT_DEFAULT_SQL from kinde-tenant-guard/prisma.`,
        );
      }
    }
  }
  if (prismaAdapters.length) {
    const registered = new Set(prismaAdapters.flatMap((a) => [...a.models.values()]));
    const fields = new Set(prismaAdapters.map((a) => a.field));
    for (const model of prismaModels) {
      const field = [...fields].find((f) => model.fields.has(f));
      if (field && !registered.has(model.name)) {
        add("unregistered-tenant-table", "error", model, `The ${model.name} model has a "${field}" field but is not registered with prismaAdapter(), so the guard does not protect it.`);
      }
    }
  }

  // Convex: tenant tables need an index that starts with the tenant field.
  for (const guard of convexGuards) {
    for (const name of guard.tables) {
      const table = convexTables.find((t) => t.name === name);
      if (!table) add("unknown-table", "warning", guard, `convexTenantGuard() registers "${name}", but no defineTable() by that name was found, so it was not checked.`);
      else if (!table.fields.has(guard.field)) add("missing-tenant-column", "error", table, `The "${name}" table is registered with convexTenantGuard() but has no "${guard.field}" field.`);
      else if (!table.indexes.some((index) => index.fields[0] === guard.field)) {
        add("missing-tenant-index", "error", table, `The "${name}" table needs an index that starts with "${guard.field}", such as .index("by_${guard.field}", ["${guard.field}"]).`);
      }
    }
  }
  if (convexGuards.length) {
    const covered = new Set(convexGuards.flatMap((g) => [...g.tables, ...g.shared]));
    const fields = new Set(convexGuards.map((g) => g.field));
    for (const table of convexTables) {
      const field = [...fields].find((f) => table.fields.has(f));
      if (field && !covered.has(table.name)) {
        add("unregistered-tenant-table", "error", table, `The "${table.name}" table has a "${field}" field but is not in convexTenantGuard()'s tables, so the guard does not protect it.`);
      }
    }
  }

  let database: VerifyResult | undefined;
  if (options.databaseUrl) {
    const tables: PostgresTenantTable[] = [];
    for (const adapter of drizzleAdapters) {
      for (const [resource, variable] of adapter.tables) {
        const table = drizzleTables.find((t) => t.variable === variable);
        const column = table?.columns.get(adapter.tenantColumn);
        if (table && column) tables.push({ resource, schema: table.schema, name: table.sqlName, column, type: "text" });
      }
    }
    for (const adapter of prismaAdapters) {
      for (const [resource, modelName] of adapter.models) {
        const model = prismaModels.find((m) => m.name === modelName);
        const field = model?.fields.get(adapter.field);
        if (model && field) tables.push({ resource, schema: "public", name: model.dbName, column: field.dbName, type: "text" });
      }
    }
    let pg: { default?: unknown; Client?: unknown };
    try {
      pg = await import("pg" as string);
    } catch {
      throw new Error("--database-url needs the pg package. Install it with: npm install --save-dev pg");
    }
    const Client = ((pg.default as { Client?: unknown } | undefined)?.Client ?? pg.Client) as new (config: { connectionString: string }) => {
      connect(): Promise<void>;
      query(text: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
      end(): Promise<void>;
    };
    const client = new Client({ connectionString: options.databaseUrl });
    await client.connect();
    try {
      database = await verifyPostgres(async (text, params) => (await client.query(text, params)).rows, tables);
    } finally {
      await client.end();
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { ok: !findings.some((f) => f.severity === "error") && (database?.ok ?? true), files: files.length, findings, database };
}
