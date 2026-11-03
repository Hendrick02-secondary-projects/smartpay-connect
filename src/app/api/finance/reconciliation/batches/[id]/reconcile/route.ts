import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTenantApi } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse } from "@/lib/http";
import { reconcileBatch } from "@/lib/reconciliation/service";

export const dynamic = "force-dynamic";

/** Finance: reconcile a settlement batch received from the (simulated) provider. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { principal, organizationId } = await requireTenantApi("tenant:reconciliation:write");
    const { id } = await params;
    const batchId = z.string().uuid().parse(id);
    const r = await reconcileBatch(getDb(), { organizationId, batchId }, { userId: principal.userId });
    return NextResponse.json({ batchReference: r.batch.batchReference, counts: r.counts, exceptions: r.exceptions });
  } catch (err) {
    return errorResponse(err);
  }
}
