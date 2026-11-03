import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireTenantApi } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/http";
import { changeAllocation } from "@/lib/kit/service";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["allocate", "flag_issue", "reset", "void"]),
  expectedVersion: z.number().int().min(1),
  receiptReference: z.string().max(60).optional().nullable(),
  allocatedOn: z.string().max(10).optional().nullable(),
  notes: z.string().max(600).optional().nullable(),
});

/** Finance: change ONE debit note's KIT allocation (tenant-scoped, optimistic-locked). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const { principal, organizationId } = await requireTenantApi("tenant:kit:allocate");
    const { id } = await params;
    const allocationId = z.string().uuid().parse(id);
    const body = schema.parse(await readJson(request, 4096));
    const result = await changeAllocation(getDb(), { organizationId, allocationId, ...body }, { userId: principal.userId });
    return NextResponse.json({ status: result.allocation.status, version: result.allocation.version, summary: result.summary });
  } catch (err) {
    return errorResponse(err);
  }
}
