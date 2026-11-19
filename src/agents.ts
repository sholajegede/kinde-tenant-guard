import { TenantGuardError } from "./errors.js";
import type { TenantGuard, TenantSession, WithTenantOptions } from "./guard.js";
import type { TenantAction } from "./policies.js";
import type { KindePrincipal } from "./principal.js";

/** One tool an AI agent can call. The tenant always comes from the signed-in principal, never from the input. */
export interface TenantToolDefinition<Scope, Input = any, Output = unknown> {
  /** The policy resource the tool works on, such as "projects". */
  resource: string;
  /** The action it performs. The principal needs the matching permission. */
  action: TenantAction;
  /** What the tool does, for the model. */
  description?: string;
  /** Runs the tool inside the tenant scope. */
  run(tenant: TenantSession<Scope>, input: Input): Promise<Output>;
}

export type TenantToolDefinitions<Scope> = Record<string, TenantToolDefinition<Scope>>;

type InputOf<D> = D extends TenantToolDefinition<any, infer I, any> ? I : never;
type OutputOf<D> = D extends TenantToolDefinition<any, any, infer O> ? O : never;

/** A tool bound to one principal, ready to hand to an agent framework. */
export interface BoundTenantTool<Input, Output> {
  name: string;
  description: string | undefined;
  resource: string;
  action: TenantAction;
  execute(input: Input): Promise<Output>;
}

export interface TenantToolSession<Defs extends TenantToolDefinitions<any>> {
  /** The tools the principal's permissions allow. Give only these to the model. */
  readonly available: { [K in keyof Defs]: BoundTenantTool<InputOf<Defs[K]>, OutputOf<Defs[K]>> }[keyof Defs][];
  /** Every tool, bound to the principal. A tool the principal may not use is refused when called. */
  readonly tools: { [K in keyof Defs]: BoundTenantTool<InputOf<Defs[K]>, OutputOf<Defs[K]>> };
  /** Calls a tool by name, for frameworks that route tool calls by name. */
  call(name: string, input: unknown): Promise<unknown>;
}

export interface TenantToolsOptions {
  /**
   * Input keys that may never appear anywhere in a tool's input, because they would let the model
   * pick a tenant. Matched without case. Default: tenantId, tenant_id, orgCode, org_code,
   * organizationCode, organization_code, organizationId, organization_id.
   */
  forbiddenInputKeys?: string[];
}

const DEFAULT_FORBIDDEN = ["tenantId", "tenant_id", "orgCode", "org_code", "organizationCode", "organization_code", "organizationId", "organization_id"];

function findForbiddenKey(value: unknown, forbidden: Set<string>, seen = new Set<unknown>()): string | null {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) return key;
    const nested = findForbiddenKey(child, forbidden, seen);
    if (nested) return nested;
  }
  return null;
}

export interface TenantTools<Defs extends TenantToolDefinitions<any>> {
  /** Binds the tools to the principal for one agent run or request. */
  forPrincipal(principal: KindePrincipal, options?: WithTenantOptions): TenantToolSession<Defs>;
  readonly definitions: Defs;
}

/**
 * Defines the tools an AI agent may call against tenant data. Each call opens its own tenant scope
 * for the signed-in principal, checks the tool's permission before it runs, and refuses input that
 * names a tenant or organization, so a prompt cannot steer the agent into another tenant.
 */
export function defineTenantTools<Scope, const Defs extends TenantToolDefinitions<Scope>>(
  guard: TenantGuard<Scope>,
  definitions: Defs,
  options: TenantToolsOptions = {},
): TenantTools<Defs> {
  const forbidden = new Set((options.forbiddenInputKeys ?? DEFAULT_FORBIDDEN).map((key) => key.toLowerCase()));

  return {
    definitions,
    forPrincipal(principal, withOptions) {
      const bind = (name: string, definition: TenantToolDefinition<Scope>): BoundTenantTool<unknown, unknown> => ({
        name,
        description: definition.description,
        resource: definition.resource,
        action: definition.action,
        execute: (input: unknown) =>
          guard.withTenant(
            principal,
            async (tenant) => {
              tenant.authorize(definition.resource, definition.action);
              const key = findForbiddenKey(input, forbidden);
              if (key) {
                throw tenant.deny(new TenantGuardError("UNSAFE_TOOL_INPUT", `The input to "${name}" contains "${key}". The tenant comes from the signed-in user, so tool input cannot name one.`));
              }
              return definition.run(tenant, input);
            },
            withOptions,
          ),
      });
      const tools = Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, bind(name, definition)])) as TenantToolSession<Defs>["tools"];
      const all = Object.values(tools) as BoundTenantTool<unknown, unknown>[];
      return {
        tools,
        available: all.filter((tool) => guard.can(principal, tool.resource, tool.action)) as TenantToolSession<Defs>["available"],
        call(name, input) {
          const tool = Object.prototype.hasOwnProperty.call(tools, name) ? (tools as Record<string, BoundTenantTool<unknown, unknown>>)[name] : undefined;
          if (!tool) return Promise.reject(new TenantGuardError("UNSAFE_TOOL_INPUT", `There is no tool named "${name}".`));
          return tool.execute(input);
        },
      };
    },
  };
}
