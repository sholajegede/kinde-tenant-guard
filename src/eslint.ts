import type { ESLint, Linter, Rule } from "eslint";

export interface NoUnguardedDbOptions {
  /** Names of your raw database clients. Default: ["db", "prisma"]. */
  clients?: string[];
  /** Names of Convex function contexts whose ctx.db is the raw database. Default: ["ctx"]. */
  convexContexts?: string[];
  /**
   * Calls whose arguments may use the raw client, because they set up the guard. Default:
   * createTenantGuard, convexTenantGuard, drizzleAdapter, prismaAdapter.
   */
  allowIn?: string[];
}

const DEFAULT_ALLOW_IN = ["createTenantGuard", "convexTenantGuard", "drizzleAdapter", "prismaAdapter"];

type Node = Rule.Node & Record<string, any>;

function calleeName(callee: any): string | null {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") return callee.property.name;
  return null;
}

function keyName(key: any): string | null {
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Reach tenant data through kinde-tenant-guard, not the raw database client.",
      url: "https://github.com/sholajegede/kinde-tenant-guard#lint-for-database-access-outside-the-guard",
    },
    schema: [
      {
        type: "object",
        properties: {
          clients: { type: "array", items: { type: "string" } },
          convexContexts: { type: "array", items: { type: "string" } },
          allowIn: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      client:
        "`{{name}}` is the raw database client, so this query is not limited to a tenant. Use `tenant.db` inside guard.withTenant(), or `system.db` inside guard.withSystem().",
      convex: "`{{name}}.db` reaches every tenant's documents. Use `t.db` inside tenants.withTenant({{name}}, (t) => ...).",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as NoUnguardedDbOptions;
    const clients = new Set(options.clients ?? ["db", "prisma"]);
    const contexts = new Set(options.convexContexts ?? ["ctx"]);
    const allowIn = new Set(options.allowIn ?? DEFAULT_ALLOW_IN);
    const sourceCode = context.sourceCode;

    // The guard's own setup, and resolveTenant(), need the raw client.
    const allowed = (node: Node) => {
      const ancestors = sourceCode.getAncestors(node) as Node[];
      return ancestors.some((ancestor, index) => {
        const child = ancestors[index + 1] ?? node;
        if (ancestor.type === "CallExpression") {
          const name = calleeName(ancestor.callee);
          return !!name && allowIn.has(name) && ancestor.arguments.includes(child as never);
        }
        if (ancestor.type === "Property" || ancestor.type === "MethodDefinition") return keyName(ancestor.key) === "resolveTenant";
        if (ancestor.type === "FunctionDeclaration") return ancestor.id?.name === "resolveTenant";
        if (ancestor.type === "VariableDeclarator") return ancestor.id?.type === "Identifier" && ancestor.id.name === "resolveTenant";
        return false;
      });
    };

    return {
      MemberExpression(node) {
        const member = node as Node;
        const object = member.object;
        if (object.type === "Identifier" && clients.has(object.name)) {
          if (!allowed(member)) context.report({ node, messageId: "client", data: { name: object.name } });
          return;
        }
        if (object.type === "Identifier" && contexts.has(object.name) && !member.computed && keyName(member.property) === "db") {
          if (!allowed(member)) context.report({ node, messageId: "convex", data: { name: object.name } });
        }
      },
      VariableDeclarator(node) {
        const declarator = node as Node;
        if (declarator.id?.type !== "ObjectPattern" || declarator.init?.type !== "Identifier" || !contexts.has(declarator.init.name)) return;
        const takesDb = declarator.id.properties.some((p: any) => p.type === "Property" && keyName(p.key) === "db");
        if (takesDb && !allowed(declarator)) context.report({ node, messageId: "convex", data: { name: declarator.init.name } });
      },
    };
  },
};

const plugin: ESLint.Plugin & { configs: Record<string, Linter.Config> } = {
  meta: { name: "kinde-tenant-guard" },
  rules: { "no-unguarded-db": rule },
  configs: {},
};

/** Turns on no-unguarded-db as an error. Spread it into eslint.config.js. */
plugin.configs.recommended = {
  plugins: { "kinde-tenant-guard": plugin },
  rules: { "kinde-tenant-guard/no-unguarded-db": "error" },
};

export const noUnguardedDb = rule;
export default plugin;
