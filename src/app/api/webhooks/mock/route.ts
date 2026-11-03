import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments/registry";
import { processProviderWebhook } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

/**
 * Webhook endpoint for the SIMULATED provider. Same pipeline a real adapter would use:
 * signature + timestamp verification, deduplication, state-machine checks, atomic effects.
 * Responds 2xx for duplicates/ignored events so providers stop retrying (retry-safe).
 */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 32 * 1024) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    const outcome = await processProviderWebhook(getDb(), getPaymentProvider(), raw, request.headers);
    if (outcome.result === "rejected") return NextResponse.json({ received: false }, { status: 401 });
    return NextResponse.json({ received: true, result: outcome.result });
  } catch (err) {
    return errorResponse(err);
  }
}
