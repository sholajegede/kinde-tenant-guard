export type TenantGuardErrorCode =
  /** The principal is missing a subject or issuer, so it was not verified. */
  | "INVALID_PRINCIPAL"
  /** The token has no active organization (no org_code). */
  | "NO_ORGANIZATION"
  /** The request asked for a different organization than the token's. */
  | "ORGANIZATION_MISMATCH"
  /** resolveTenant() found no tenant for the organization. */
  | "UNKNOWN_TENANT"
  /** The principal lacks the permission a policy requires. */
  | "FORBIDDEN"
  /** No policy exists for the resource, so access is refused. */
  | "POLICY_MISSING"
  /** A write tried to set or change another tenant's ownership. */
  | "CROSS_TENANT_WRITE"
  /** A table that is not registered with the adapter was used in a tenant scope. */
  | "UNSCOPED_TABLE"
  /** A query the adapter cannot limit to the tenant, such as raw SQL without row-level security. */
  | "UNSAFE_QUERY"
  /** An agent tool call carried a tenant or organization in its input, or named an unknown tool. */
  | "UNSAFE_TOOL_INPUT"
  /** withSystem() was called without a reason. */
  | "SYSTEM_REASON_REQUIRED"
  /** The database is not set up to enforce isolation, found by verify(). */
  | "UNSAFE_DATABASE";

/** Every refusal from kinde-tenant-guard. Check `code` instead of the message. */
export class TenantGuardError extends Error {
  readonly code: TenantGuardErrorCode;
  /** HTTP status that fits the refusal: 401, 403 or 500. */
  readonly status: number;

  constructor(code: TenantGuardErrorCode, message: string) {
    super(message);
    this.name = "TenantGuardError";
    this.code = code;
    this.status = code === "INVALID_PRINCIPAL" ? 401 : code === "UNSAFE_DATABASE" || code === "SYSTEM_REASON_REQUIRED" ? 500 : 403;
  }
}

export function isTenantGuardError(error: unknown, code?: TenantGuardErrorCode): error is TenantGuardError {
  return error instanceof TenantGuardError && (code === undefined || error.code === code);
}
