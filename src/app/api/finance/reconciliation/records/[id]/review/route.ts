import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTenantApi } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/http";
import { resolveException } from "@/lib/reconciliation/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  decision: z.enum(["manually_reconciled", "rejected", "under_review"]),
  reason: z.string().trim().min(10, "Indique um motivo detalhado (mín. 10 caracteres).").max(500),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { principal, organizationId } = await requireTenantApi("tenant:reconciliation:write");
    const { id } = await params;
    const body = schema.parse(await readJson(request, 4096));
    const recordId = z.string().uuid().parse(id);
    const result = await resolveException(getDb(), { organizationId, recordId, ...body }, { userId: principal.userId });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
