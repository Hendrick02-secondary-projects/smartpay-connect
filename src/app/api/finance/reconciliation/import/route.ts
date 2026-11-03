import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireTenantApi } from "@/lib/auth/session";
import { assertSameOrigin, errorResponse, HttpError } from "@/lib/http";
import { consumeRateLimit } from "@/lib/rate-limit";
import { parseSettlementFile } from "@/lib/reconciliation/parser-xlsx";
import { fileHash, importSettlement } from "@/lib/reconciliation/service";

export const dynamic = "force-dynamic";
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { principal, organizationId } = await requireTenantApi("tenant:reconciliation:write");
    const db = getDb();
    const rl = await consumeRateLimit(db, `recon:import:${principal.userId}`, 20, 10 * 60);
    if (!rl.allowed) throw new HttpError(429, "rate_limited", "Demasiadas importações. Aguarde alguns minutos.");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(422, "file_required", "Seleccione um ficheiro .csv ou .xlsx.");
    if (file.size === 0 || file.size > MAX_BYTES) throw new HttpError(422, "file_size", "O ficheiro deve ter entre 1 byte e 2 MB.");
    const name = file.name.replace(/[^\w.\-]/g, "_").slice(0, 180);
    const buffer = Buffer.from(await file.arrayBuffer());

    const parsed = await parseSettlementFile(name, buffer);
    if (!parsed.ok) throw new HttpError(422, "invalid_file", "O ficheiro contém erros e não foi importado.", parsed.errors);

    const result = await importSettlement(
      db,
      { organizationId, source: "file_import", scenario: "file", fileName: name, fileHash: fileHash(buffer), rows: parsed.rows },
      { userId: principal.userId },
    );
    return NextResponse.json({ batchId: result.batch.id, batchReference: result.batch.batchReference, counts: result.counts, exceptions: result.exceptions });
  } catch (err) {
    return errorResponse(err);
  }
}
