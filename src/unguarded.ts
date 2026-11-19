// The detection behind the no-unguarded-db ESLint rule and the `check` command. Both walk an
// ESTree AST and call findUnguarded() for each node with its ancestors, so they flag the same code.

export interface UnguardedOptions {
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

export const UNGUARDED_MESSAGES = {
  client:
    "`{{name}}` is the raw database client, so this query is not limited to a tenant. Use `tenant.db` inside guard.withTenant(), or `system.db` inside guard.withSystem().",
  convex: "`{{name}}.db` reaches every tenant's documents. Use `t.db` inside tenants.withTenant({{name}}, (t) => ...).",
} as const;

export type UnguardedMessageId = keyof typeof UNGUARDED_MESSAGES;

export interface UnguardedFinding {
  messageId: UnguardedMessageId;
  name: string;
}

const DEFAULT_ALLOW_IN = ["createTenantGuard", "convexTenantGuard", "drizzleAdapter", "prismaAdapter"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

export function calleeName(callee: AnyNode): string | null {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") return callee.property.name;
  return null;
}

export function keyName(key: AnyNode): string | null {
  if (key?.type === "Identifier") return key.name;
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

export function unguardedMessage(finding: UnguardedFinding): string {
  return UNGUARDED_MESSAGES[finding.messageId].replace(/\{\{name\}\}/g, finding.name);
}

/** Returns a checker for one set of options. Call it with each node and its ancestors, outermost first. */
export function createUnguardedChecker(options: UnguardedOptions = {}) {
  const clients = new Set(options.clients ?? ["db", "prisma"]);
  const contexts = new Set(options.convexContexts ?? ["ctx"]);
  const allowIn = new Set(options.allowIn ?? DEFAULT_ALLOW_IN);

  // The guard's own setup, and resolveTenant(), need the raw client.
  const allowed = (node: AnyNode, ancestors: AnyNode[]) =>
    ancestors.some((ancestor, index) => {
      const child = ancestors[index + 1] ?? node;
      if (ancestor.type === "CallExpression") {
        const name = calleeName(ancestor.callee);
        return !!name && allowIn.has(name) && ancestor.arguments.includes(child);
      }
      if (ancestor.type === "Property" || ancestor.type === "MethodDefinition") return keyName(ancestor.key) === "resolveTenant";
      if (ancestor.type === "FunctionDeclaration") return ancestor.id?.name === "resolveTenant";
      if (ancestor.type === "VariableDeclarator") return ancestor.id?.type === "Identifier" && ancestor.id.name === "resolveTenant";
      return false;
    });

  return function check(node: AnyNode, ancestors: AnyNode[]): UnguardedFinding | null {
    if (node.type === "MemberExpression") {
      const object = node.object;
      if (object?.type !== "Identifier") return null;
      if (clients.has(object.name)) return allowed(node, ancestors) ? null : { messageId: "client", name: object.name };
      if (contexts.has(object.name) && !node.computed && keyName(node.property) === "db") {
        return allowed(node, ancestors) ? null : { messageId: "convex", name: object.name };
      }
      return null;
    }
    if (node.type === "VariableDeclarator") {
      if (node.id?.type !== "ObjectPattern" || node.init?.type !== "Identifier" || !contexts.has(node.init.name)) return null;
      const takesDb = node.id.properties.some((p: AnyNode) => p.type === "Property" && keyName(p.key) === "db");
      return takesDb && !allowed(node, ancestors) ? { messageId: "convex", name: node.init.name } : null;
    }
    return null;
  };
}
