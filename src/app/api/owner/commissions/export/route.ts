import { getDb } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { requireOwnerApi } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { ppmToPercentString } from "@/lib/money";
import { getOwnerKpis, listLedger } from "@/lib/queries/owner";
import { commissionLedgerWorkbook } from "@/lib/reports/excel";
import { LIFECYCLE_LABELS } from "@/lib/labels";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const owner = await requireOwnerApi("platform:dashboard");
    const db = getDb();
    const [ledger, k] = await Promise.all([listLedger(db, 1, 50_000), getOwnerKpis(db)]);
    const buffer = await commissionLedgerWorkbook(
      ledger.rows.map((r) => ({
        createdAt: r.entry.createdAt,
        entryType: r.entry.entryType,
        paymentReference: r.paymentReference,
        organization: r.organization,
        ruleVersion: r.entry.ruleVersion,
        ratePercent: r.entry.ratePpm === null ? null : ppmToPercentString(r.entry.ratePpm),
        baseAmountMinor: r.entry.baseAmountMinor,
        amountMinor: r.entry.amountMinor,
        lifecycle: LIFECYCLE_LABELS[r.lifecycle] ?? r.lifecycle,
        invoiceNumber: r.invoiceNumber,
        reason: r.entry.reason,
      })),
      {
        "Comissão bruta acumulada": k.accrued,
        "Ajustes e reversões": k.adjustments,
        "Comissão líquida devida": k.netDue,
        Facturado: k.invoiced,
        Cobrado: k.collected,
        "Em dívida": k.outstanding,
      },
    );
    await writeAudit(db, { organizationId: null, actorType: "user", actorUserId: owner.userId, action: "report.commission_ledger_exported", entityType: "report", metadata: { rows: ledger.rows.length } });
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="DEMO-smartpay-ledger-comissoes-${new Date().toISOString().slice(0, 10)}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
