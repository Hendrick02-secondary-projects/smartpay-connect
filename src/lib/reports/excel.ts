import "server-only";
import ExcelJS from "exceljs";
import { minorToDecimalString } from "@/lib/money";
import { SETTLEMENT_COLUMNS } from "@/lib/reconciliation/parser";

// SmartPay Connect brand colour (matches --primary in globals.css).
const BRAND = "FF2F4BD0";

function banner(ws: ExcelJS.Worksheet, title: string, columns: number) {
  ws.mergeCells(1, 1, 1, columns);
  const c = ws.getCell(1, 1);
  c.value = `${title} — DEMONSTRAÇÃO · DADOS SIMULADOS · NÃO CONSTITUI REGISTO CONTABILÍSTICO`;
  c.font = { bold: true, color: { argb: "FFFFFFFF" } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
  c.alignment = { vertical: "middle" };
  ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, columns);
  ws.getCell(2, 1).value = `Gerado em ${new Date().toISOString()} pelo SmartPay Connect (gateway simulado).`;
  ws.getCell(2, 1).font = { italic: true, size: 9, color: { argb: "FF6B6266" } };
}

function header(ws: ExcelJS.Worksheet, rowIdx: number, labels: string[]) {
  const row = ws.getRow(rowIdx);
  labels.forEach((l, i) => {
    const cell = row.getCell(i + 1);
    cell.value = l;
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1EEEC" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFDDD6D3" } } };
  });
  ws.views = [{ state: "frozen", ySplit: rowIdx }];
}

/**
 * Amounts are written as exact decimal NUMBERS derived from integer minor units
 * (via string conversion, not float arithmetic) with a 2-decimal number format.
 */
const money = (minor: number) => Number(minorToDecimalString(minor));

export interface TransactionExportRow {
  reference: string;
  customerName: string;
  customerPhone: string;
  debitNotes: string;
  amountMinor: number;
  method: string;
  account: string;
  status: string;
  reconciliationStatus: string;
  createdAt: Date;
}

export async function transactionsWorkbook(rows: TransactionExportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SmartPay Connect (demo)";
  const ws = wb.addWorksheet("Transacções");
  const labels = ["Referência", "Segurado", "Telemóvel", "Notas de débito", "Valor (MZN)", "Método", "Conta de destino", "Estado", "Reconciliação", "Criado em"];
  banner(ws, "Transacções SmartPay Payments", labels.length);
  header(ws, 4, labels);
  for (const r of rows) {
    ws.addRow([r.reference, r.customerName, r.customerPhone, r.debitNotes, money(r.amountMinor), r.method, r.account, r.status, r.reconciliationStatus, r.createdAt]);
  }
  ws.getColumn(5).numFmt = "#,##0.00";
  ws.getColumn(10).numFmt = "yyyy-mm-dd hh:mm";
  [18, 26, 16, 32, 14, 16, 30, 14, 20, 18].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const total = rows.reduce((a, r) => a + r.amountMinor, 0);
  const tr = ws.addRow(["TOTAL", "", "", `${rows.length} transacções`, money(total)]);
  tr.font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface LedgerExportRow {
  createdAt: Date;
  entryType: string;
  paymentReference: string | null;
  organization: string;
  ruleVersion: number | null;
  ratePercent: string | null;
  baseAmountMinor: number | null;
  amountMinor: number;
  lifecycle: string;
  invoiceNumber: string | null;
  reason: string | null;
}

export async function commissionLedgerWorkbook(rows: LedgerExportRow[], summary: Record<string, number>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SmartPay Connect (demo)";
  const ws = wb.addWorksheet("Ledger de comissões");
  const labels = ["Data", "Tipo", "Pagamento", "Organização", "Versão regra", "Taxa (%)", "Base (MZN)", "Comissão (MZN)", "Ciclo de vida", "Factura", "Motivo"];
  banner(ws, "Ledger de comissões SmartPay", labels.length);
  header(ws, 4, labels);
  for (const r of rows) {
    ws.addRow([
      r.createdAt,
      r.entryType,
      r.paymentReference ?? "",
      r.organization,
      r.ruleVersion ?? "",
      r.ratePercent ?? "",
      r.baseAmountMinor === null ? "" : money(r.baseAmountMinor),
      money(r.amountMinor),
      r.lifecycle,
      r.invoiceNumber ?? "",
      r.reason ?? "",
    ]);
  }
  ws.getColumn(1).numFmt = "yyyy-mm-dd hh:mm";
  ws.getColumn(7).numFmt = "#,##0.00";
  ws.getColumn(8).numFmt = "#,##0.00;[Red]-#,##0.00";
  [18, 12, 22, 22, 12, 10, 14, 15, 18, 20, 48].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const s = wb.addWorksheet("Resumo");
  banner(s, "Resumo de comissões", 2);
  header(s, 4, ["Indicador", "Valor (MZN)"]);
  for (const [k, v] of Object.entries(summary)) s.addRow([k, money(v)]);
  s.getColumn(2).numFmt = "#,##0.00;[Red]-#,##0.00";
  s.getColumn(1).width = 36;
  s.getColumn(2).width = 18;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Standardised example settlement file, pre-filled with real (simulated) payment references. */
export async function settlementTemplateWorkbook(
  examples: { reference: string; amountMinor: number; bankAccountCode: string }[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Settlement");
  banner(ws, "Ficheiro de liquidação (exemplo)", SETTLEMENT_COLUMNS.length);
  header(ws, 4, [...SETTLEMENT_COLUMNS]);
  const today = new Date().toISOString().slice(0, 10);
  const stamp = Date.now().toString(36).toUpperCase();
  examples.forEach((e, i) => {
    const ref = `BNK-${stamp}-${String(i + 1).padStart(3, "0")}`;
    // Deliberate exceptions so the demo shows every reconciliation outcome.
    let amount = e.amountMinor;
    let account = e.bankAccountCode;
    let pref = e.reference;
    if (i === 1) amount = e.amountMinor - 10_000; // amount mismatch (-100 MZN)
    if (i === 2) pref = "SPC-000000-UNKNOWN0"; // unknown reference
    if (i === 3) account = "DEMO-XXX-99"; // account mismatch -> under review
    ws.addRow([ref, pref, account, "credit", minorToDecimalString(amount), "", "", minorToDecimalString(amount), "SETTLED", today]);
    if (i === 4) ws.addRow([ref, pref, account, "credit", minorToDecimalString(amount), "", "", minorToDecimalString(amount), "SETTLED", today]); // duplicate
  });
  [26, 24, 16, 14, 14, 12, 12, 14, 12, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const help = wb.addWorksheet("Instruções");
  [
    "Ficheiro de exemplo para a demonstração de reconciliação (dados simulados).",
    "Colunas obrigatórias: settlement_reference, gross_amount, value_date.",
    "movement_type: credit | fee_debit | reversal_debit. Valores em MZN com ponto ou vírgula decimal.",
    "As linhas 2–5 contêm excepções propositadas: valor divergente, referência desconhecida, conta divergente e duplicado.",
    "Um ficheiro idêntico não pode ser importado duas vezes.",
  ].forEach((t) => help.addRow([t]));
  help.getColumn(1).width = 110;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
