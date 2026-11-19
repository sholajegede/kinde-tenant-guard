import { KindeTestkit, scenario } from "kinde-testkit";
import { isTenantGuardError, type TenantGuardErrorCode } from "./errors.js";
import type { TenantGuard, TenantSession } from "./guard.js";
import { principalFromClaims, type KindePrincipal } from "./principal.js";

/** One of the two organizations a test runs as, with credentials minted by kinde-testkit. */
export interface IsolationOrganization {
  /** The Kinde organization code. */
  code: string;
  /** The principal for createTenantGuard().withTenant(). */
  principal: KindePrincipal;
  /** A signed Kinde access token, for calling your API over HTTP. */
  token: string;
  /** The verified token claims. */
  claims: Record<string, unknown>;
  /** The claims in the shape of a Convex UserIdentity, for convex-test's withIdentity(). */
  identity: { subject: string; issuer: string; [claim: string]: any };
}

/**
 * How to create, list, read, update and delete one kind of record. Each function gets the session
 * (the tenant scope with a guard, or the organization without one) and the organization it runs as.
 */
export interface IsolationResource<Session, Row = any> {
  /** Creates a record that belongs to the organization. */
  create(session: Session, organization: IsolationOrganization): Promise<Row>;
  /** Lists the records the organization can see. */
  list(session: Session, organization: IsolationOrganization): Promise<Row[]>;
  /** Reads one record by ID. Another organization's record must come back empty or be refused. */
  get?(session: Session, id: unknown, organization: IsolationOrganization): Promise<Row | null | undefined>;
  /** Changes a record. Run against another organization's record, it must change nothing. */
  update?(session: Session, row: Row, organization: IsolationOrganization): Promise<unknown>;
  /** Deletes a record. Run against another organization's record, it must delete nothing. */
  remove?(session: Session, row: Row, organization: IsolationOrganization): Promise<unknown>;
  /** The record's ID. Default: row.id, then row._id. */
  id?(row: Row): unknown;
}

export type IsolationOperation = "create" | "read" | "get" | "update" | "delete" | "organization";

export interface IsolationCheck {
  resource: string;
  operation: IsolationOperation;
  ok: boolean;
  detail: string;
}

export interface IsolationReport {
  ok: boolean;
  checks: IsolationCheck[];
  organizations: [IsolationOrganization, IsolationOrganization];
}

interface CommonOptions {
  /** The two organization codes to test with. Each must map to a tenant in your app. */
  organizations: [string, string];
  /** The kinde-testkit instance that mints the tokens. Default: a new KindeTestkit. */
  testkit?: KindeTestkit | { testkit: KindeTestkit };
  /** Roles for both test users. */
  roles?: string[];
}

export interface GuardIsolationOptions<Scope> extends CommonOptions {
  /** The records to test, by resource name. */
  resources: Record<string, IsolationResource<TenantSession<Scope>>>;
  /** Permissions for both test users. Default: every permission in the guard's policies. */
  permissions?: string[];
}

export interface StandaloneIsolationOptions extends CommonOptions {
  /** The records to test, by resource name. Each function calls your app as the organization, for example through convex-test or HTTP. */
  resources: Record<string, IsolationResource<IsolationOrganization>>;
  /** Permissions for both test users. */
  permissions?: string[];
}

/** Thrown when a check fails. The full report is on `report`. */
export class TenantIsolationError extends Error {
  readonly report: IsolationReport;
  constructor(report: IsolationReport) {
    const failed = report.checks.filter((check) => !check.ok);
    super(`Tenant isolation failed ${failed.length} of ${report.checks.length} checks:\n${failed.map((c) => `  - ${c.resource} ${c.operation}: ${c.detail}`).join("\n")}`);
    this.name = "TenantIsolationError";
    this.report = report;
  }
}

const snapshot = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
const defaultId = (row: any) => row?.id ?? row?._id;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function organizationsFor(options: CommonOptions, permissions: string[]): Promise<[IsolationOrganization, IsolationOrganization]> {
  const given = options.testkit;
  const testkit = given ? ("testkit" in given ? given.testkit : given) : await KindeTestkit.create();
  const make = async (code: string): Promise<IsolationOrganization> => {
    const user = scenario()
      .user({ email: `isolation@${code.replace(/[^a-z0-9]/gi, "-")}.test` })
      .organization(code)
      .permissions(permissions)
      .roles(options.roles ?? [])
      .authenticated();
    const token = await testkit.tokenFor(user);
    if (!token) throw new Error(`kinde-testkit returned no token for ${code}.`);
    const claims = (await testkit.verify(token)) as Record<string, unknown>;
    return { code, principal: principalFromClaims(claims), token, claims, identity: { ...claims, subject: String(claims.sub), issuer: String(claims.iss) } };
  };
  const [a, b] = options.organizations;
  if (!a || !b || a === b) throw new Error("testIsolation() needs two different organization codes.");
  return [await make(a), await make(b)];
}

async function run<Session>(
  orgs: [IsolationOrganization, IsolationOrganization],
  resources: Record<string, IsolationResource<Session>>,
  as: <T>(org: IsolationOrganization, fn: (session: Session) => Promise<T>) => Promise<T>,
  checks: IsolationCheck[],
) {
  const [a, b] = orgs;
  const pass = (resource: string, operation: IsolationOperation, detail: string) => checks.push({ resource, operation, ok: true, detail });
  const fail = (resource: string, operation: IsolationOperation, detail: string) => checks.push({ resource, operation, ok: false, detail });

  for (const [name, resource] of Object.entries(resources)) {
    const idOf = resource.id ?? defaultId;
    let rowA: unknown;
    let rowB: unknown;
    try {
      rowA = await as(a, (s) => resource.create(s, a));
      rowB = await as(b, (s) => resource.create(s, b));
    } catch (error) {
      fail(name, "create", `Creating a record failed, so nothing else was tested: ${message(error)}`);
      continue;
    }
    const idA = idOf(rowA);
    const idB = idOf(rowB);
    if (idA === undefined || idB === undefined) {
      fail(name, "create", "create() returned a record without an ID. Return the created record, or pass id(row).");
      continue;
    }
    pass(name, "create", `Created ${String(idA)} as ${a.code} and ${String(idB)} as ${b.code}.`);

    const listed = async (org: IsolationOrganization) => (await as(org, (s) => resource.list(s, org))).map((row) => ({ id: idOf(row), row }));
    const findB = async () => (await listed(b)).find((entry) => entry.id === idB)?.row;

    for (const [self, own, other, otherId] of [
      [a, idA, b, idB],
      [b, idB, a, idA],
    ] as const) {
      const ids = (await listed(self)).map((entry) => entry.id);
      if (!ids.includes(own)) fail(name, "read", `${self.code} cannot see its own record ${String(own)}.`);
      else if (ids.includes(otherId)) fail(name, "read", `${self.code} can see ${other.code}'s record ${String(otherId)}.`);
      else pass(name, "read", `${self.code} sees its own records and none of ${other.code}'s.`);
    }

    if (resource.get) {
      try {
        const found = await as(a, (s) => resource.get!(s, idB, a));
        if (found === null || found === undefined) pass(name, "get", `${a.code} reading ${b.code}'s record by ID got nothing.`);
        else fail(name, "get", `${a.code} read ${b.code}'s record ${String(idB)} by ID.`);
      } catch (error) {
        pass(name, "get", `${a.code} reading ${b.code}'s record by ID was refused: ${message(error)}`);
      }
    }

    const before = await findB();
    if (resource.update) {
      let refusal = "";
      try {
        await as(a, (s) => resource.update!(s, rowB, a));
      } catch (error) {
        refusal = ` It was refused: ${message(error)}`;
      }
      const after = await findB();
      if (after === undefined) fail(name, "update", `${a.code}'s update removed ${b.code}'s record ${String(idB)} from ${b.code}'s view.`);
      else if (snapshot(after) !== snapshot(before)) fail(name, "update", `${a.code} changed ${b.code}'s record ${String(idB)}.`);
      else pass(name, "update", `${a.code} could not change ${b.code}'s record.${refusal}`);
    }

    if (resource.remove) {
      let refusal = "";
      try {
        await as(a, (s) => resource.remove!(s, rowB, a));
      } catch (error) {
        refusal = ` It was refused: ${message(error)}`;
      }
      if ((await findB()) === undefined) fail(name, "delete", `${a.code} deleted ${b.code}'s record ${String(idB)}.`);
      else pass(name, "delete", `${a.code} could not delete ${b.code}'s record.${refusal}`);
      // Clean up the test records as their owners. A failure here is not an isolation failure.
      await as(a, (s) => resource.remove!(s, rowA, a)).catch(() => undefined);
      await as(b, (s) => resource.remove!(s, rowB, b)).catch(() => undefined);
    }
  }
}

async function expectRefusal(checks: IsolationCheck[], code: TenantGuardErrorCode, detail: string, attempt: () => Promise<unknown>) {
  try {
    await attempt();
    checks.push({ resource: "guard", operation: "organization", ok: false, detail: `${detail} was allowed.` });
  } catch (error) {
    const ok = isTenantGuardError(error, code);
    checks.push({ resource: "guard", operation: "organization", ok, detail: ok ? `${detail} was refused with ${code}.` : `${detail} failed with ${message(error)}, not ${code}.` });
  }
}

/**
 * Proves that two Kinde organizations cannot reach each other's records. It mints a token for
 * each organization with kinde-testkit, creates a record as each, then checks reads, reads by ID,
 * updates and deletes across the boundary. Throws a TenantIsolationError when a check fails.
 *
 * Pass a guard from createTenantGuard() and each function gets the tenant scope. Leave it out
 * to call your app another way, such as through convex-test or HTTP, with the organization's
 * identity or token.
 */
export function testIsolation<Scope>(guard: TenantGuard<Scope>, options: GuardIsolationOptions<Scope>): Promise<IsolationReport>;
export function testIsolation(options: StandaloneIsolationOptions): Promise<IsolationReport>;
export async function testIsolation<Scope>(
  first: TenantGuard<Scope> | StandaloneIsolationOptions,
  second?: GuardIsolationOptions<Scope>,
): Promise<IsolationReport> {
  const checks: IsolationCheck[] = [];
  let organizations: [IsolationOrganization, IsolationOrganization];

  if (second) {
    const guard = first as TenantGuard<Scope>;
    const everything = [...new Set(Object.values(guard.policies ?? {}).flatMap((policy) => Object.values(policy.permissions ?? {})))].filter((p): p is string => !!p);
    organizations = await organizationsFor(second, second.permissions ?? everything);
    const [a, b] = organizations;
    await expectRefusal(checks, "NO_ORGANIZATION", "A token with no active organization", () =>
      guard.withTenant({ ...a.principal, organization: null }, async () => undefined),
    );
    await expectRefusal(checks, "ORGANIZATION_MISMATCH", `A request as ${a.code} that names ${b.code}`, () =>
      guard.withTenant(a.principal, async () => undefined, { organizationCode: b.code }),
    );
    await run(organizations, second.resources, (org, fn) => guard.withTenant(org.principal, fn), checks);
  } else {
    const options = first as StandaloneIsolationOptions;
    organizations = await organizationsFor(options, options.permissions ?? []);
    await run(organizations, options.resources, (org, fn) => fn(org), checks);
  }

  const report: IsolationReport = { ok: checks.every((check) => check.ok), checks, organizations };
  if (!report.ok) throw new TenantIsolationError(report);
  return report;
}
