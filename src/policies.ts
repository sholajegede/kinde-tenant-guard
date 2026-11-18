export type TenantAction = "read" | "create" | "update" | "delete";

export interface ResourcePolicy {
  /**
   * "required": every operation belongs to the active tenant.
   * "global": shared by all tenants, such as a plans table.
   * "system": only reachable through withSystem().
   */
  tenant: "required" | "global" | "system";
  /** The Kinde permission each action needs. An action that is not listed is refused. */
  permissions?: Partial<Record<TenantAction, string>>;
}

export type Policies = Record<string, ResourcePolicy>;

/** Declares which Kinde permission each action on each resource needs. */
export function definePolicies<const P extends Policies>(policies: P): P {
  return Object.freeze(policies);
}
