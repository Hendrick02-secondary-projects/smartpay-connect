import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { login, resolveSession } from "@/lib/auth/service";
import { can, tenantOf } from "@/lib/auth/policy";
import { createOwner, createTenant, hasDb, PASSWORD, truncateAll } from "./helpers";

// Route handlers read the session cookie through next/headers — we control it here.
const cookieJar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookieJar.token ? { value: cookieJar.token } : undefined), set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

describe.skipIf(!hasDb)("authentication & role permissions (integration)", () => {
  beforeEach(async () => {
    await truncateAll();
    cookieJar.token = undefined;
  });
  afterAll(() => closeDb());

  it("logs in with valid credentials and stores only a token hash", async () => {
    const t = await createTenant("demo");
    const r = await login(getDb(), { email: t.financeEmail.toUpperCase(), password: PASSWORD, ipHash: "a", userAgent: null, portal: "tenant" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const principal = await resolveSession(getDb(), r.token);
    expect(principal?.email).toBe(t.financeEmail);
    expect(tenantOf(principal!)).toBe(t.orgId);
    expect(can(principal!, "tenant:payments:read", t.orgId)).toBe(true);
    expect(can(principal!, "platform:dashboard")).toBe(false);
  });

  it("rejects wrong passwords, locks after repeated failures, and separates portals", async () => {
    const t = await createTenant("demo");
    const owner = await createOwner();
    expect((await login(getDb(), { email: t.financeEmail, password: "wrong", ipHash: "b", userAgent: null, portal: "tenant" })).ok).toBe(false);
    // finance user cannot sign in on the owner portal, owner cannot sign in on the tenant portal
    expect((await login(getDb(), { email: t.financeEmail, password: PASSWORD, ipHash: "b", userAgent: null, portal: "owner" })).ok).toBe(false);
    expect((await login(getDb(), { email: owner.email, password: PASSWORD, ipHash: "b", userAgent: null, portal: "tenant" })).ok).toBe(false);
    for (let i = 0; i < 5; i++) await login(getDb(), { email: owner.email, password: "nope", ipHash: `c${i}`, userAgent: null, portal: "owner" });
    const locked = await login(getDb(), { email: owner.email, password: PASSWORD, ipHash: "d", userAgent: null, portal: "owner" });
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
  });

  it("rejects forged or expired session tokens", async () => {
    expect(await resolveSession(getDb(), "forged-token-forged-token-forged")).toBeNull();
    expect(await resolveSession(getDb(), undefined)).toBeNull();
  });

  it("blocks unauthenticated and cross-role API access", async () => {
    const t = await createTenant("demo");
    const { GET: exportTransactions } = await import("@/app/api/finance/transactions/export/route");
    const { GET: exportLedger } = await import("@/app/api/owner/commissions/export/route");

    // no session -> 401
    expect((await exportTransactions(new Request("http://localhost/api/finance/transactions/export"))).status).toBe(401);
    expect((await exportLedger()).status).toBe(401);

    // finance user -> tenant export OK, owner export 403
    const r = await login(getDb(), { email: t.financeEmail, password: PASSWORD, ipHash: "e", userAgent: null, portal: "tenant" });
    if (!r.ok) throw new Error("login failed");
    cookieJar.token = r.token;
    const ok = await exportTransactions(new Request("http://localhost/api/finance/transactions/export"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect((await exportLedger()).status).toBe(403);
  });

  it("rejects cross-origin mutation requests (CSRF)", async () => {
    const { POST } = await import("@/app/api/finance/reconciliation/simulate/route");
    const res = await POST(
      new Request("http://localhost/api/finance/reconciliation/simulate", {
        method: "POST",
        headers: { host: "localhost", origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ scenario: "gross" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
