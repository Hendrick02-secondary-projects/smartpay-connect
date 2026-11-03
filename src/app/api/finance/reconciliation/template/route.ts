import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { bankAccounts, paymentIntents } from "@/lib/db/schema";
import { requireTenantApi } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { settlementTemplateWorkbook } from "@/lib/reports/excel";

export const dynamic = "force-dynamic";

/** Example settlement file pre-filled with this tenant's unreconciled successful payments (+ deliberate exceptions). */
export async function GET() {
  try {
    const { organizationId } = await requireTenantApi("tenant:reconciliation:write");
    const rows = await getDb()
      .select({ reference: paymentIntents.reference, amountMinor: paymentIntents.amountMinor, bankAccountCode: bankAccounts.code })
      .from(paymentIntents)
      .innerJoin(bankAccounts, eq(bankAccounts.id, paymentIntents.bankAccountId))
      .where(
        and(
          eq(paymentIntents.organizationId, organizationId),
          eq(paymentIntents.status, "successful"),
          eq(paymentIntents.reconciliationStatus, "unreconciled"),
        ),
      )
      .orderBy(desc(paymentIntents.createdAt))
      .limit(12);
    const buffer = await settlementTemplateWorkbook(rows);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="DEMO-ficheiro-liquidacao-exemplo.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
