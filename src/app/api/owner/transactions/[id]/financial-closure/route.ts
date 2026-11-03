import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireOwnerApi } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse, readJson } from "@/lib/http";
import { closeProcess, reopenProcess } from "@/lib/lifecycle/service";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("close"), notes: z.string().max(500).optional().nullable() }),
  z.object({ action: z.literal("reopen"), reason: z.string().trim().min(10, "Indique o motivo da reabertura (mín. 10 caracteres).").max(500) }),
]);

/** Platform owner: close / reopen the SmartPay FINANCIAL process of a transaction. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const owner = await requireOwnerApi("platform:financial:close");
    const { id } = await params;
    const paymentIntentId = z.string().uuid().parse(id);
    const body = schema.parse(await readJson(request, 2048));
    const db = getDb();
    if (body.action === "close") {
      const closure = await closeProcess(db, { kind: "financial", paymentIntentId, organizationId: null, notes: body.notes }, { userId: owner.userId });
      return NextResponse.json({ closedAt: closure.closedAt });
    }
    await reopenProcess(db, { kind: "financial", paymentIntentId, organizationId: null, reason: body.reason }, { userId: owner.userId });
    return NextResponse.json({ reopened: true });
  } catch (err) {
    return errorResponse(err);
  }
}
