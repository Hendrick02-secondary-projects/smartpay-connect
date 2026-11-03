/**
 * Authorisation policy — PURE. Every server entry point (page, server action,
 * API route) calls these functions; hiding UI is never the control.
 */
export type RoleName = "finance_user" | "finance_admin" | "platform_owner";

export type Permission =
  | "tenant:payments:read"
  | "tenant:reports:export"
  | "tenant:reconciliation:write"
  | "tenant:kit:allocate"
  | "tenant:operations:close"
  | "platform:dashboard"
  | "platform:commission:write"
  | "platform:organizations:manage"
  | "platform:demo:control"
  | "platform:financial:close";

export interface Principal {
  userId: string;
  email: string;
  name: string;
  roles: { role: RoleName; organizationId: string | null }[];
}

const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  finance_user: ["tenant:payments:read", "tenant:reports:export", "tenant:reconciliation:write", "tenant:kit:allocate", "tenant:operations:close"],
  finance_admin: ["tenant:payments:read", "tenant:reports:export", "tenant:reconciliation:write", "tenant:kit:allocate", "tenant:operations:close"],
  // The platform owner can SIMULATE provider/bank/collection events, but never reconcile,
  // allocate in KIT or close a tenant's operational process: those are tenant permissions.
  platform_owner: [
    "platform:dashboard",
    "platform:commission:write",
    "platform:organizations:manage",
    "platform:demo:control",
    "platform:financial:close",
  ],
};

/**
 * Tenant permissions require a role bound to THAT organisation.
 * Platform permissions require the platform_owner role (organisation-less).
 */
export function can(principal: Principal, permission: Permission, organizationId?: string): boolean {
  return principal.roles.some((r) => {
    if (!ROLE_PERMISSIONS[r.role].includes(permission)) return false;
    if (permission.startsWith("tenant:")) return !!organizationId && r.organizationId === organizationId;
    return r.organizationId === null;
  });
}

/** The single organisation a tenant user is scoped to (V1: one tenant per user). */
export function tenantOf(principal: Principal): string | null {
  return principal.roles.find((r) => r.role !== "platform_owner" && r.organizationId)?.organizationId ?? null;
}

export function isPlatformOwner(principal: Principal): boolean {
  return principal.roles.some((r) => r.role === "platform_owner" && r.organizationId === null);
}
