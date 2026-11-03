import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { assertSameOrigin, clientIp, errorResponse, readJson } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments/registry";
import { createPaymentIntent } from "@/lib/payments/service";
import { hashIp } from "@/lib/security/crypto";
import { createPaymentSchema } from "@/lib/validation/payment";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  try {
    assertSameOrigin(request);
    const { org } = await params;
    const input = createPaymentSchema.parse(await readJson(request));
    const result = await createPaymentIntent(getDb(), getPaymentProvider(), org, input, { ipHash: hashIp(clientIp(request.headers)) });
    return NextResponse.json(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
