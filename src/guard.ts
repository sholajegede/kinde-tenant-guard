import { TenantGuardError } from "./errors.js";
import type { Policies, TenantAction } from "./policies.js";
import type { KindePrincipal } from "./principal.js";

// The Web Crypto global works in Node 20+, edge runtimes and the Convex runtime, unlike node:crypto.
const randomUUID = () => globalThis.crypto.randomUUID();

/** The trusted tenant for one request. Frozen, so nothing can change it after it is created. */
export interface TenantContext {
  readonly kind: "tenant";
  /** Your application's internal tenant ID, from resolveTenant(). */
  readonly tenantId: string;
  /** The Kinde organization code it came from. */
  readonly organizationCode: string;
  readonly principal: {
    readonly type: "user" | "machine";
    /** The Kinde user ID, or the client ID for a machine. */
    readonly userId: string;
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
  };
  readonly requestId: string;
  readonly issuedAt: number;
}

/** A privileged context for background jobs and admin tasks. */
export interface SystemContext {
  readonly kind: "system";
  readonly reason: string;
  /** Set when the job works for one tenant, for example a nightly job per organization. */
  readonly tenantId: string | null;
  readonly requestId: string;
  readonly issuedAt: number;
}

export type AuditEvent =
  | { type: "access.denied"; code: TenantGuardError["code"]; message: string; requestId: string; subject: string | null; organizationCode: string | null; tenantId: string | null; at: string }
  | { type: "system.access"; reason: string; requestId: string; tenantId: string | null; at: string };

/** What the guard gives the adapter for each scope it opens. */
export interface ScopeHooks {
  /** Throws unless the active principal may perform the action on the resource. */
  authorize(resource: string, action: TenantAction): void;
  /** Reports a refusal from the adapter, such as a cross-tenant write. */
  deny(error: TenantGuardError): TenantGuardError;
}

/** A database adapter, such as drizzleAdapter(). */
export interface TenantAdapter<Scope> {
  readonly name: string;
  run<T>(context: TenantContext, hooks: ScopeHooks, fn: (scope: Scope) => Promise<T>): Promise<T>;
  runSystem<T>(context: SystemContext, hooks: ScopeHooks, fn: (scope: Scope) => Promise<T>): Promise<T>;
  /** Checks that the database enforces isolation. */
  verify?(): Promise<VerifyResult>;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** SQL that fixes a failed check. */
  fix?: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

export type TenantSession<Scope> = Scope & {
  /** The trusted tenant for this request. */
  readonly context: TenantContext;
  /** True when the principal may perform the action on the resource. */
  can(resource: string, action: TenantAction): boolean;
  /** Throws a FORBIDDEN TenantGuardError unless the principal may perform the action. */
  authorize(resource: string, action: TenantAction): void;
  /** Writes a refusal of your own to the audit log and returns the error, so you can throw it. */
  deny(error: TenantGuardError): TenantGuardError;
};

export type SystemSession<Scope> = Scope & { readonly context: SystemContext };

export interface TenantGuardOptions<Scope> {
  adapter: TenantAdapter<Scope>;
  /**
   * Maps the verified Kinde organization code to your application's tenant ID. Return null when
   * the organization is unknown, and the request is refused.
   */
  resolveTenant(organizationCode: string, principal: KindePrincipal): Promise<string | null> | string | null;
  /** The permission each action on each resource needs. Without policies, the guard checks tenancy only. */
  policies?: Policies;
  /** Called for every refusal and every system access. */
  onAudit?(event: AuditEvent): void;
}

export interface WithTenantOptions {
  /** An ID that ties audit events to your request logs. */
  requestId?: string;
  /**
   * An organization the request asked for, such as a URL parameter. It must match the token's
   * active organization, so a request can never pick a tenant the token does not grant.
   */
  organizationCode?: string;
}

export interface TenantGuard<Scope> {
  /** Runs fn with a database scope that only reaches the principal's active organization. */
  withTenant<T>(principal: KindePrincipal, fn: (tenant: TenantSession<Scope>) => Promise<T>, options?: WithTenantOptions): Promise<T>;
  /** Runs fn with system access, for background jobs. Needs a reason, and is audited. */
  withSystem<T>(options: { reason: string; tenantId?: string; requestId?: string }, fn: (system: SystemSession<Scope>) => Promise<T>): Promise<T>;
  /**
   * True when the principal's permissions allow the action on the resource. It checks policies
   * only, without resolving the tenant, so it suits deciding which tools or buttons to show.
   */
  can(principal: KindePrincipal, resource: string, action: TenantAction): boolean;
  /** The policies the guard was created with. */
  readonly policies: Policies | undefined;
  /** Checks that the database enforces isolation. */
  verify(): Promise<VerifyResult>;
  /** Throws an UNSAFE_DATABASE TenantGuardError when verify() finds a problem. */
  assertSafe(): Promise<void>;
}

function permits(policies: Policies | undefined, permissions: readonly string[], resource: string, action: TenantAction, system: boolean): TenantGuardError | null {
  if (!policies) return null;
  const policy = policies[resource];
  if (!policy) return new TenantGuardError("POLICY_MISSING", `No policy covers "${resource}". Add it to definePolicies() so access to it is decided, not assumed.`);
  if (policy.tenant === "system" && !system) return new TenantGuardError("FORBIDDEN", `"${resource}" is a system resource. Use withSystem() to reach it.`);
  if (system) return null;
  const needed = policy.permissions?.[action];
  if (!needed) return new TenantGuardError("FORBIDDEN", `The policy for "${resource}" allows no "${action}" action.`);
  if (!permissions.includes(needed)) return new TenantGuardError("FORBIDDEN", `"${action}" on "${resource}" needs the "${needed}" permission.`);
  return null;
}

/** Creates the guard your request handlers and jobs use to reach tenant data. */
export function createTenantGuard<Scope>(options: TenantGuardOptions<Scope>): TenantGuard<Scope> {
  const audit = (event: AuditEvent) => {
    try {
      options.onAudit?.(event);
    } catch {
      // A failing audit sink must not change the security decision.
    }
  };
  const now = () => new Date().toISOString();

  function refuse(error: TenantGuardError, requestId: string, principal: KindePrincipal | null, tenantId: string | null): never {
    audit({
      type: "access.denied",
      code: error.code,
      message: error.message,
      requestId,
      subject: principal?.subject || null,
      organizationCode: principal?.organization?.code ?? null,
      tenantId,
      at: now(),
    });
    throw error;
  }

  async function withTenant<T>(principal: KindePrincipal, fn: (tenant: TenantSession<Scope>) => Promise<T>, opts: WithTenantOptions = {}): Promise<T> {
    const requestId = opts.requestId ?? randomUUID();
    if (!principal || typeof principal.subject !== "string" || !principal.subject || typeof principal.issuer !== "string" || !principal.issuer) {
      refuse(new TenantGuardError("INVALID_PRINCIPAL", "The principal has no subject or issuer. Build it from a verified Kinde token."), requestId, principal ?? null, null);
    }
    const organizationCode = principal.organization?.code;
    if (!organizationCode) {
      refuse(new TenantGuardError("NO_ORGANIZATION", "The token has no active organization (org_code), so no tenant data can be reached."), requestId, principal, null);
    }
    if (opts.organizationCode !== undefined && opts.organizationCode !== organizationCode) {
      refuse(
        new TenantGuardError("ORGANIZATION_MISMATCH", `The request asked for "${opts.organizationCode}", but the token's active organization is "${organizationCode}".`),
        requestId,
        principal,
        null,
      );
    }
    const tenantId = await options.resolveTenant(organizationCode, principal);
    if (typeof tenantId !== "string" || !tenantId) {
      refuse(new TenantGuardError("UNKNOWN_TENANT", `No tenant is mapped to the Kinde organization "${organizationCode}".`), requestId, principal, null);
    }
    const context: TenantContext = Object.freeze({
      kind: "tenant",
      tenantId,
      organizationCode,
      principal: Object.freeze({
        type: principal.type,
        userId: principal.subject,
        roles: Object.freeze([...principal.roles]),
        permissions: Object.freeze([...principal.permissions]),
      }),
      requestId,
      issuedAt: Date.now(),
    });
    const can = (resource: string, action: TenantAction) => permits(options.policies, context.principal.permissions, resource, action, false) === null;
    const authorize = (resource: string, action: TenantAction) => {
      const error = permits(options.policies, context.principal.permissions, resource, action, false);
      if (error) refuse(error, requestId, principal, tenantId);
    };
    const deny = (error: TenantGuardError): TenantGuardError => {
      try {
        refuse(error, requestId, principal, tenantId);
      } catch {
        // refuse() records the event and throws; the caller decides where to throw.
      }
      return error;
    };
    const hooks: ScopeHooks = { authorize, deny };
    return options.adapter.run(context, hooks, (scope) => fn(Object.assign(Object.create(null), scope, { context, can, authorize, deny }) as TenantSession<Scope>));
  }

  async function withSystem<T>(opts: { reason: string; tenantId?: string; requestId?: string }, fn: (system: SystemSession<Scope>) => Promise<T>): Promise<T> {
    const requestId = opts.requestId ?? randomUUID();
    if (!opts || typeof opts.reason !== "string" || opts.reason.trim().length < 3) {
      refuse(new TenantGuardError("SYSTEM_REASON_REQUIRED", "withSystem() needs a reason, such as \"nightly invoice export\". It is written to the audit log."), requestId, null, opts?.tenantId ?? null);
    }
    const context: SystemContext = Object.freeze({ kind: "system", reason: opts.reason.trim(), tenantId: opts.tenantId ?? null, requestId, issuedAt: Date.now() });
    audit({ type: "system.access", reason: context.reason, requestId, tenantId: context.tenantId, at: now() });
    const hooks: ScopeHooks = {
      authorize: (resource, action) => {
        const error = permits(options.policies, [], resource, action, true);
        if (error) refuse(error, requestId, null, context.tenantId);
      },
      deny: (error) => refuse(error, requestId, null, context.tenantId),
    };
    return options.adapter.runSystem(context, hooks, (scope) => fn(Object.assign(Object.create(null), scope, { context }) as SystemSession<Scope>));
  }

  async function verify(): Promise<VerifyResult> {
    if (!options.adapter.verify) return { ok: true, checks: [{ name: "adapter", ok: true, detail: `The ${options.adapter.name} adapter has no database checks.` }] };
    return options.adapter.verify();
  }

  return {
    withTenant,
    withSystem,
    policies: options.policies,
    can: (principal, resource, action) => !!principal?.organization && permits(options.policies, principal.permissions ?? [], resource, action, false) === null,
    verify,
    async assertSafe() {
      const result = await verify();
      if (!result.ok) {
        const failed = result.checks.filter((c) => !c.ok);
        throw new TenantGuardError(
          "UNSAFE_DATABASE",
          `The database does not enforce tenant isolation:\n${failed.map((c) => `  - ${c.name}: ${c.detail}${c.fix ? `\n    Fix: ${c.fix}` : ""}`).join("\n")}`,
        );
      }
    },
  };
}
