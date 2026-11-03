import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { assertSameOrigin, clientIp, errorResponse, HttpError, readJson } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { getCustomerPaymentView } from "@/lib/payments/service";
import { hashIp } from "@/lib/security/crypto";

export const dynamic = "force-dynamic";

const schema = z.object({ clientSecret: z.string().min(20).max(100) });

/**
 * Returns the customer's own payment (status + demo confirmation data).
 * POST so the capability secret travels in the body — never in URLs, logs or referrers.
 */
export async function POST(request: Request, { params }: { params: Promise<{ org: string; reference: string }> }) {
  try {
    assertSameOrigin(request);
    const { org, reference } = await params;
    const db = getDb();
    const rl = await consumeRateLimit(db, `pay:view:${hashIp(clientIp(request.headers)) ?? "unknown"}`, 300, 10 * 60);
    if (!rl.allowed) throw new HttpError(429, "rate_limited", "Demasiados pedidos. Aguarde alguns minutos.");
    const { clientSecret } = schema.parse(await readJson(request, 2048));
    const view = await getCustomerPaymentView(db, org, reference, clientSecret);
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
