import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { assertSameOrigin, clientIp, errorResponse, HttpError, readJson } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getPaymentProvider } from "@/lib/payments/registry";
import { resolvePendingPayment } from "@/lib/payments/service";
import { hashIp } from "@/lib/security/crypto";
import { resolvePendingSchema } from "@/lib/validation/payment";

export const dynamic = "force-dynamic";

/** Demo control: simulates the provider's asynchronous final callback for a pending payment. */
export async function POST(request: Request, { params }: { params: Promise<{ org: string; reference: string }> }) {
  try {
    assertSameOrigin(request);
    const { org, reference } = await params;
    const db = getDb();
    const rl = await consumeRateLimit(db, `pay:resolve:${hashIp(clientIp(request.headers)) ?? "unknown"}`, 30, 10 * 60);
    if (!rl.allowed) throw new HttpError(429, "rate_limited", "Demasiados pedidos. Aguarde alguns minutos.");
    const body = resolvePendingSchema.parse(await readJson(request, 4096));
    const result = await resolvePendingPayment(db, getPaymentProvider(), org, reference, body.clientSecret, body.resolution);
    return NextResponse.json({ status: result.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
