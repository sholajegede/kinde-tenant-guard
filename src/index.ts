export { TenantGuardError, isTenantGuardError, type TenantGuardErrorCode } from "./errors.js";
export { principalFromClaims, verifyKindeToken, type KindePrincipal, type VerifyKindeTokenOptions } from "./principal.js";
export { definePolicies, type Policies, type ResourcePolicy, type TenantAction } from "./policies.js";
export {
  createTenantGuard,
  type AuditEvent,
  type ScopeHooks,
  type SystemContext,
  type SystemSession,
  type TenantAdapter,
  type TenantContext,
  type TenantGuard,
  type TenantGuardOptions,
  type TenantSession,
  type VerifyCheck,
  type VerifyResult,
  type WithTenantOptions,
} from "./guard.js";
