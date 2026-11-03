import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTenantApi } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments/registry";
import { generateSimulatedSettlement } from "@/lib/reconciliation/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  scenario: z.enum(["gross", "net", "separate_fee_debit", "aggregated", "reversal"]),
  limit: z.number().int().min(1).max(200).optional(),
});

/** Asks the SIMULATED provider for a settlement of unsettled payments (stored pending reconciliation). */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { principal, organizationId } = await requireTenantApi("tenant:reconciliation:write");
    const body = schema.parse(await readJson(request, 1024));
    const result = await generateSimulatedSettlement(getDb(), getPaymentProvider(), { organizationId, ...body }, { userId: principal.userId });
    // The simulated provider only DELIVERS the settlement; the batch waits for Finance to reconcile it.
    return NextResponse.json({ batchId: result.batch.id, batchReference: result.batch.batchReference, pending: true, payments: result.payments, lines: result.lines });
  } catch (err) {
    return errorResponse(err);
  }
}
