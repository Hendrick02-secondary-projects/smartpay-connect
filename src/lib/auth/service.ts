import "server-only";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { Executor } from "@/lib/db";
import { sessions, userRoles, users } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit";
import { consumeRateLimit } from "@/lib/rate-limit";
import { randomToken, sha256Hex } from "@/lib/security/crypto";
import { verifyPassword } from "./password";
import type { Principal, RoleName } from "./policy";

export const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8h absolute
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export type LoginResult =
  | { ok: true; token: string; principal: Principal; expiresAt: Date }
  | { ok: false; reason: "invalid_credentials" | "rate_limited" | "locked" };

/**
 * Verifies credentials and creates a DB-backed session.
 * Only SHA-256(token) is stored; the raw token lives in an httpOnly cookie.
 */
export async function login(
  db: Executor,
  input: { email: string; password: string; ipHash: string | null; userAgent: string | null; portal: "tenant" | "owner" },
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const ipLimit = await consumeRateLimit(db, `login:ip:${input.ipHash ?? "unknown"}`, 20, 15 * 60);
  const emailLimit = await consumeRateLimit(db, `login:email:${sha256Hex(email)}`, 10, 15 * 60);
  if (!ipLimit.allowed || !emailLimit.allowed) return { ok: false, reason: "rate_limited" };

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? null);

  if (!user || !user.isActive) return { ok: false, reason: "invalid_credentials" };
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return { ok: false, reason: "locked" };

  if (!passwordOk) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
      })
      .where(eq(users.id, user.id));
    await writeAudit(db, {
      organizationId: user.organizationId,
      actorType: "public",
      action: failed >= MAX_FAILED_LOGINS ? "auth.account_locked" : "auth.login_failed",
      entityType: "user",
      entityId: user.id,
      ipHash: input.ipHash,
    });
    return { ok: false, reason: "invalid_credentials" };
  }

  const principal = await loadPrincipal(db, user.id);
  if (!principal) return { ok: false, reason: "invalid_credentials" };

  // Portal separation: owners sign in only on the owner portal, tenant users only on the tenant portal.
  const isOwner = principal.roles.some((r) => r.role === "platform_owner");
  if ((input.portal === "owner") !== isOwner) return { ok: false, reason: "invalid_credentials" };

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: sha256Hex(token),
    expiresAt,
    ipHash: input.ipHash,
    userAgent: input.userAgent?.slice(0, 256) ?? null,
  });
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));
  await writeAudit(db, {
    organizationId: user.organizationId,
    actorType: "user",
    actorUserId: user.id,
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
    ipHash: input.ipHash,
  });
  // Opportunistic cleanup of expired sessions (cheap, indexed).
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));

  return { ok: true, token, principal, expiresAt };
}

export async function loadPrincipal(db: Executor, userId: string): Promise<Principal | null> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      isActive: users.isActive,
      role: userRoles.role,
      organizationId: userRoles.organizationId,
    })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .where(eq(users.id, userId));
  const first = rows[0];
  if (!first || !first.isActive) return null;
  return {
    userId: first.userId,
    email: first.email,
    name: first.name,
    roles: rows.map((r) => ({ role: r.role as RoleName, organizationId: r.organizationId })),
  };
}

/**
 * Resolves a raw session token to a principal.
 * Returns null ONLY when the session is missing/expired/revoked. Database errors
 * propagate (so callers show a retryable error instead of logging the user out).
 */
export async function resolveSession(db: Executor, token: string | undefined | null): Promise<Principal | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const tokenHash = sha256Hex(token);
  const [session] = await db
    .select({ id: sessions.id, userId: sessions.userId, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!session) return null;
  // Throttled "last seen" update (at most every 5 minutes) — keeps navigation cheap.
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, session.id));
  }
  return loadPrincipal(db, session.userId);
}

export async function revokeSession(db: Executor, token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256Hex(token)));
}
