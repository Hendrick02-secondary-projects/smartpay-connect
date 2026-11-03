import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireTenantApi } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { METHOD_LABELS, PAYMENT_STATUS_LABELS, RECON_STATE_LABELS } from "@/lib/labels";
import { listTransactions, transactionFiltersSchema } from "@/lib/queries/finance";
import { transactionsWorkbook } from "@/lib/reports/excel";

export const dynamic = "force-dynamic";
const MAX_EXPORT_ROWS = 10_000;

export async function GET(request: Request) {
  try {
    const { principal, organizationId } = await requireTenantApi("tenant:reports:export");
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const filters = transactionFiltersSchema.parse({ ...params, page: 1 });
    const db = getDb();
    const data = await listTransactions(db, organizationId, filters, MAX_EXPORT_ROWS);
    const buffer = await transactionsWorkbook(
      data.rows.map((r) => ({
        reference: r.reference,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        debitNotes: r.debitNotes ?? "",
        amountMinor: r.amountMinor,
        method: METHOD_LABELS[r.method] ?? r.method,
        account: `${r.bankName} ${r.accountNumberMasked}`,
        status: PAYMENT_STATUS_LABELS[r.status] ?? r.status,
        reconciliationStatus: RECON_STATE_LABELS[r.reconciliationStatus] ?? r.reconciliationStatus,
        createdAt: r.createdAt,
      })),
    );
    await writeAudit(db, {
      organizationId,
      actorType: "user",
      actorUserId: principal.userId,
      action: "report.transactions_exported",
      entityType: "report",
      metadata: { rows: data.rows.length, filters: { ...filters, q: filters.q ? "[set]" : undefined } },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="DEMO-smartpay-transaccoes-${stamp}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
