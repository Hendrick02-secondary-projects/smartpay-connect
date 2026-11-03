/**
 * Simulated settlement model — PURE.
 *
 * Represents the TARGET commercial model (the insurer receives gross, SmartPay receives
 * an agreed commission, gateway fees recorded separately) and the alternatives a
 * real provider might impose. NONE of these behaviours is claimed to be supported
 * by any real provider: every generated line is flagged as simulated.
 *
 * Every line separates three things:
 *  - the BANK MOVEMENT on the insurer's account (statement lines only: net amount, signed);
 *  - the GATEWAY FEE attributable to the payment (gatewayFeeMinor);
 *  - the SMARTPAY COMMISSION attributable to the payment (platformFeeMinor).
 * "detail" lines break an aggregated statement credit down per payment; they are not
 * bank movements themselves.
 */
import { applyRatePpm } from "@/lib/money";

export type ScenarioKey = "gross" | "net" | "separate_fee_debit" | "aggregated" | "reversal";
export type FeatureStatusKey = "simulated" | "not_verified" | "contractually_confirmed" | "technically_tested";
export type FeeTreatment = "invoiced_separately" | "deducted" | "debited_separately" | "not_applicable";

/** FICTIONAL gateway fee rates used only by the simulator (ppm). */
export const SIMULATED_GATEWAY_FEE_PPM = {
  card: 25_000, // 2.5%
  mpesa: 10_000, // 1.0%
  emola: 10_000, // 1.0%
} as const;

export const SCENARIOS: Record<ScenarioKey, { label: string; description: string; featureStatus: FeatureStatusKey; feeTreatment: FeeTreatment }> = {
  gross: {
    label: "Liquidação bruta",
    description: "Um crédito por pagamento com o valor bruto. Taxa do gateway e comissão SmartPay ficam registadas e são facturadas à parte.",
    featureStatus: "simulated",
    feeTreatment: "invoiced_separately",
  },
  net: {
    label: "Liquidação líquida",
    description: "Um crédito por pagamento já líquido: o gateway deduz a sua taxa e retém a comissão SmartPay antes de creditar a seguradora.",
    featureStatus: "simulated",
    feeTreatment: "deducted",
  },
  separate_fee_debit: {
    label: "Débito de taxas separado",
    description: "Créditos brutos por pagamento e, no fim do lote, dois débitos distintos: um da taxa do gateway e outro da comissão SmartPay.",
    featureStatus: "simulated",
    feeTreatment: "debited_separately",
  },
  aggregated: {
    label: "Liquidação agregada",
    description: "Um único crédito bancário cobre vários pagamentos. As linhas de detalhe ligam cada pagamento a esse crédito; só reconcilia se a soma bater certo.",
    featureStatus: "simulated",
    feeTreatment: "invoiced_separately",
  },
  reversal: {
    label: "Reversão",
    description: "Débito de reversão para pagamentos revertidos após liquidação.",
    featureStatus: "simulated",
    feeTreatment: "not_applicable",
  },
};

export const FEE_TREATMENT_LABELS: Record<FeeTreatment, string> = {
  invoiced_separately: "Taxas facturadas à parte",
  deducted: "Taxas deduzidas no crédito",
  debited_separately: "Taxas debitadas em separado",
  not_applicable: "Sem taxas",
};

export const FEATURE_STATUS_LABELS: Record<FeatureStatusKey, string> = {
  simulated: "Simulado",
  not_verified: "Não verificado",
  contractually_confirmed: "Confirmado contratualmente",
  technically_tested: "Testado tecnicamente",
};

export interface SettleablePayment {
  reference: string;
  amountMinor: number;
  method: keyof typeof SIMULATED_GATEWAY_FEE_PPM;
  bankAccountCode: string;
  commissionMinor: number;
}

export interface GeneratedLine {
  settlementReference: string;
  paymentReference: string | null;
  bankAccountCode: string | null;
  movementType: "credit" | "fee_debit" | "reversal_debit";
  lineKind: "statement" | "detail";
  parentReference: string | null;
  feeKind: "gateway" | "platform" | null;
  grossAmountMinor: number;
  gatewayFeeMinor: number;
  platformFeeMinor: number;
  /** Signed effect on the insurer's bank account (statement lines). Detail lines: their share of the aggregate. */
  netAmountMinor: number;
  reportedStatus: string;
}

export function gatewayFeeFor(p: Pick<SettleablePayment, "amountMinor" | "method">): number {
  return applyRatePpm(p.amountMinor, SIMULATED_GATEWAY_FEE_PPM[p.method]);
}

export function buildSettlementLines(scenario: ScenarioKey, batchReference: string, payments: readonly SettleablePayment[]): GeneratedLine[] {
  const lines: GeneratedLine[] = [];
  const statement = { lineKind: "statement" as const, parentReference: null, feeKind: null };

  if (scenario === "aggregated") {
    if (payments.length === 0) return lines;
    const aggRef = `${batchReference}-AGG`;
    const total = payments.reduce((a, p) => a + p.amountMinor, 0);
    const accounts = new Set(payments.map((p) => p.bankAccountCode));
    lines.push({
      ...statement,
      settlementReference: aggRef,
      paymentReference: null,
      bankAccountCode: accounts.size === 1 ? payments[0]!.bankAccountCode : null,
      movementType: "credit",
      grossAmountMinor: total,
      gatewayFeeMinor: 0,
      platformFeeMinor: 0,
      netAmountMinor: total,
      reportedStatus: "SETTLED",
    });
    payments.forEach((p, i) =>
      lines.push({
        settlementReference: `${aggRef}-D${String(i + 1).padStart(4, "0")}`,
        paymentReference: p.reference,
        bankAccountCode: p.bankAccountCode,
        movementType: "credit",
        lineKind: "detail",
        parentReference: aggRef,
        feeKind: null,
        grossAmountMinor: p.amountMinor,
        gatewayFeeMinor: gatewayFeeFor(p),
        platformFeeMinor: p.commissionMinor,
        netAmountMinor: p.amountMinor,
        reportedStatus: "SETTLED",
      }),
    );
    return lines;
  }

  payments.forEach((p, i) => {
    const n = String(i + 1).padStart(4, "0");
    const fee = gatewayFeeFor(p);
    const common = {
      ...statement,
      settlementReference: `${batchReference}-${n}`,
      paymentReference: p.reference,
      bankAccountCode: p.bankAccountCode,
      grossAmountMinor: p.amountMinor,
      gatewayFeeMinor: fee,
      platformFeeMinor: p.commissionMinor,
    };
    switch (scenario) {
      case "gross":
      case "separate_fee_debit":
        lines.push({ ...common, movementType: "credit", netAmountMinor: p.amountMinor, reportedStatus: "SETTLED" });
        break;
      case "net":
        lines.push({ ...common, movementType: "credit", netAmountMinor: p.amountMinor - fee - p.commissionMinor, reportedStatus: "SETTLED" });
        break;
      case "reversal":
        lines.push({ ...common, movementType: "reversal_debit", gatewayFeeMinor: 0, platformFeeMinor: 0, netAmountMinor: -p.amountMinor, reportedStatus: "REVERSED" });
        break;
    }
  });

  if (scenario === "separate_fee_debit" && payments.length > 0) {
    const totalGateway = payments.reduce((a, p) => a + gatewayFeeFor(p), 0);
    const totalPlatform = payments.reduce((a, p) => a + p.commissionMinor, 0);
    const debit = { ...statement, paymentReference: null, bankAccountCode: null, movementType: "fee_debit" as const, reportedStatus: "SETTLED" };
    if (totalGateway > 0)
      lines.push({ ...debit, settlementReference: `${batchReference}-FEE-GW`, feeKind: "gateway", grossAmountMinor: totalGateway, gatewayFeeMinor: totalGateway, platformFeeMinor: 0, netAmountMinor: -totalGateway });
    if (totalPlatform > 0)
      lines.push({ ...debit, settlementReference: `${batchReference}-FEE-SP`, feeKind: "platform", grossAmountMinor: totalPlatform, gatewayFeeMinor: 0, platformFeeMinor: totalPlatform, netAmountMinor: -totalPlatform });
  }
  return lines;
}

export interface MovementBreakdown {
  /** gross value of the payments covered by the batch */
  gross: number;
  /** gateway fees attributable to those payments */
  gatewayFees: number;
  /** SmartPay commission attributable to those payments */
  platformFees: number;
  /** net signed effect on the insurer's bank account (statement lines only) */
  net: number;
  /** of which: fees deducted at source, and fees debited separately */
  deducted: number;
  debitedGateway: number;
  debitedPlatform: number;
  bankMovements: number;
}

type LineForTotals = Pick<GeneratedLine, "movementType" | "grossAmountMinor" | "gatewayFeeMinor" | "platformFeeMinor" | "netAmountMinor" | "paymentReference"> & {
  lineKind?: "statement" | "detail";
  feeKind?: "gateway" | "platform" | null;
};

/** Totals that let the UI show every movement separately, without double counting aggregates. */
export function settlementTotals(lines: readonly LineForTotals[]): MovementBreakdown {
  const t: MovementBreakdown = { gross: 0, gatewayFees: 0, platformFees: 0, net: 0, deducted: 0, debitedGateway: 0, debitedPlatform: 0, bankMovements: 0 };
  for (const l of lines) {
    const kind = l.lineKind ?? "statement";
    const paymentCredit = l.movementType === "credit" && !!l.paymentReference;
    if (paymentCredit) {
      t.gross += l.grossAmountMinor;
      t.gatewayFees += l.gatewayFeeMinor;
      t.platformFees += l.platformFeeMinor;
    }
    if (kind === "statement") {
      t.net += l.netAmountMinor;
      t.bankMovements++;
      if (paymentCredit) t.deducted += l.grossAmountMinor - l.netAmountMinor;
      if (l.movementType === "fee_debit") {
        if (l.feeKind === "platform") t.debitedPlatform += l.grossAmountMinor;
        else t.debitedGateway += l.grossAmountMinor;
      }
    }
  }
  return t;
}
