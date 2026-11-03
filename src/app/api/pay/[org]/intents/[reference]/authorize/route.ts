import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { assertSameOrigin, clientIp, errorResponse, HttpError, readJson } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getPaymentProvider } from "@/lib/payments/registry";
import { authorizeSimulatedPayment } from "@/lib/payments/service";
import { hashIp } from "@/lib/security/crypto";
import { authorizeSchema } from "@/lib/validation/payment";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ org: string; reference: string }> }) {
  try {
    assertSameOrigin(request);
    const { org, reference } = await params;
    const db = getDb();
    const rl = await consumeRateLimit(db, `pay:auth:${hashIp(clientIp(request.headers)) ?? "unknown"}`, 30, 10 * 60);
    if (!rl.allowed) throw new HttpError(429, "rate_limited", "Demasiados pedidos. Aguarde alguns minutos.");
    const body = authorizeSchema.parse(await readJson(request, 4096));
    const result = await authorizeSimulatedPayment(db, getPaymentProvider(), org, reference, body.clientSecret, body.scenario);
    return NextResponse.json({ status: result.status, scenario: result.scenario }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
