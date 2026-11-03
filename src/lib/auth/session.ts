import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { can, isPlatformOwner, tenantOf, type Permission, type Principal } from "./policy";
import { resolveSession } from "./service";

/**
 * In production the cookie uses the "__Host-" prefix: Secure, Path=/, no Domain —
 * it cannot be set by sub-domains or sent over plain HTTP.
 */
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-sp_session" : "sp_session";

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/** Memoised per request so layouts + pages share one DB lookup. */
export const getCurrentPrincipal = cache(async (): Promise<Principal | null> => {
  const store = await cookies();
  return resolveSession(getDb(), store.get(SESSION_COOKIE)?.value);
});

export interface TenantContext {
  principal: Principal;
  organizationId: string;
}

/** For tenant pages: redirect to login if unauthenticated; 404 if not a tenant user. */
export async function requireTenantPage(permission: Permission = "tenant:payments:read"): Promise<TenantContext> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const organizationId = tenantOf(principal);
  if (!organizationId || !can(principal, permission, organizationId)) notFound();
  return { principal, organizationId };
}

/** For owner pages: unauthenticated users are sent to the (unlinked) owner login. Others get 404. */
export async function requireOwnerPage(permission: Permission = "platform:dashboard"): Promise<Principal> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/owner/login");
  if (!isPlatformOwner(principal) || !can(principal, permission)) notFound();
  return principal;
}

/** For API routes: throws 401/403 HttpErrors instead of redirecting. */
export async function requireTenantApi(permission: Permission): Promise<TenantContext> {
  const principal = await getCurrentPrincipal();
  if (!principal) throw new HttpError(401, "unauthenticated", "Sessão inválida ou expirada.");
  const organizationId = tenantOf(principal);
  if (!organizationId || !can(principal, permission, organizationId)) {
    throw new HttpError(403, "forbidden", "Sem permissão para esta operação.");
  }
  return { principal, organizationId };
}

export async function requireOwnerApi(permission: Permission): Promise<Principal> {
  const principal = await getCurrentPrincipal();
  if (!principal) throw new HttpError(401, "unauthenticated", "Sessão inválida ou expirada.");
  if (!isPlatformOwner(principal) || !can(principal, permission)) {
    throw new HttpError(403, "forbidden", "Sem permissão para esta operação.");
  }
  return principal;
}
