/**
 * Settlement file parsing — PURE (CSV + generic row mapping). XLSX cells are read in
 * parser-xlsx.ts and fed into the same `mapRows` so both formats share validation.
 *
 * Standard columns (header names are case/space-insensitive):
 *   settlement_reference | payment_reference | bank_account | movement_type |
 *   gross_amount | gateway_fee | platform_fee | net_amount | status | value_date
 * Optional (V1.1): line_kind (statement | detail) | parent_reference | fee_kind (gateway | platform)
 * V1.0 files without the optional columns remain valid.
 */
import { parseMznToMinor } from "@/lib/money";
import type { MovementKind } from "./matcher";

export const SETTLEMENT_COLUMNS = [
  "settlement_reference",
  "payment_reference",
  "bank_account",
  "movement_type",
  "gross_amount",
  "gateway_fee",
  "platform_fee",
  "net_amount",
  "status",
  "value_date",
] as const;

export const OPTIONAL_SETTLEMENT_COLUMNS = ["line_kind", "parent_reference", "fee_kind"] as const;

const REQUIRED = ["settlement_reference", "gross_amount", "value_date"] as const;
export const MAX_ROWS = 5_000;

export interface ParsedSettlementRow {
  rowNumber: number;
  settlementReference: string;
  paymentReference: string | null;
  bankAccountCode: string | null;
  movementType: MovementKind;
  grossAmountMinor: number;
  gatewayFeeMinor: number;
  platformFeeMinor: number;
  netAmountMinor: number;
  reportedStatus: string | null;
  valueDate: string;
  lineKind: "statement" | "detail";
  parentReference: string | null;
  feeKind: "gateway" | "platform" | null;
}

export interface ParseError {
  row: number;
  message: string;
}

export type ParseResult = { ok: true; rows: ParsedSettlementRow[] } | { ok: false; errors: ParseError[] };

/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF), auto-detects ";" vs ",". */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]!;
    if (inQuotes) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(s); // dd/mm/yyyy (Mozambican convention)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function movement(raw: string): MovementKind | null {
  const s = raw.trim().toLowerCase();
  if (!s || s === "credit" || s === "credito" || s === "crédito") return "credit";
  if (s === "fee_debit" || s === "fee" || s === "taxa" || s === "debito_taxas") return "fee_debit";
  if (s === "reversal_debit" || s === "reversal" || s === "reversao" || s === "reversão") return "reversal_debit";
  return null;
}

/** Maps a header row + data rows (as strings) into validated settlement rows. */
export function mapRows(table: string[][]): ParseResult {
  if (table.length < 2) return { ok: false, errors: [{ row: 1, message: "O ficheiro não tem linhas de dados." }] };
  if (table.length - 1 > MAX_ROWS) return { ok: false, errors: [{ row: 1, message: `Máximo de ${MAX_ROWS} linhas por ficheiro.` }] };
  const header = table[0]!.map(norm);
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { ok: false, errors: [{ row: 1, message: `Colunas obrigatórias em falta: ${missing.join(", ")}` }] };
  const col = (name: string) => header.indexOf(name);

  const errors: ParseError[] = [];
  const rows: ParsedSettlementRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2;
    const get = (name: string) => {
      const idx = col(name);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const settlementReference = get("settlement_reference").toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9\-_/.]{2,79}$/.test(settlementReference)) {
      errors.push({ row: rowNumber, message: "settlement_reference inválida" });
      return;
    }
    const mv = movement(get("movement_type"));
    if (!mv) {
      errors.push({ row: rowNumber, message: "movement_type inválido (credit | fee_debit | reversal_debit)" });
      return;
    }
    const gross = parseMznToMinor(get("gross_amount"));
    if (gross === null || gross <= 0) {
      errors.push({ row: rowNumber, message: "gross_amount inválido (valor positivo em MZN)" });
      return;
    }
    const optionalAmount = (name: string) => {
      const raw = get(name);
      if (!raw) return 0;
      const neg = raw.startsWith("-");
      const v = parseMznToMinor(neg ? raw.slice(1) : raw);
      return v === null ? NaN : neg ? -v : v;
    };
    const gatewayFee = optionalAmount("gateway_fee");
    const platformFee = optionalAmount("platform_fee");
    const netRaw = optionalAmount("net_amount");
    if ([gatewayFee, platformFee, netRaw].some((v) => Number.isNaN(v))) {
      errors.push({ row: rowNumber, message: "Valor de taxa/líquido inválido" });
      return;
    }
    const valueDate = normalizeDate(get("value_date"));
    if (!valueDate) {
      errors.push({ row: rowNumber, message: "value_date inválida (AAAA-MM-DD ou DD/MM/AAAA)" });
      return;
    }
    const net = get("net_amount") ? netRaw : mv === "credit" ? gross : -gross;
    const kindRaw = get("line_kind").toLowerCase();
    const lineKind = !kindRaw || kindRaw === "statement" || kindRaw === "extracto" ? "statement" : kindRaw === "detail" || kindRaw === "detalhe" ? "detail" : null;
    if (!lineKind) {
      errors.push({ row: rowNumber, message: "line_kind inválido (statement | detail)" });
      return;
    }
    const parentReference = get("parent_reference").toUpperCase() || null;
    if (lineKind === "detail" && !parentReference) {
      errors.push({ row: rowNumber, message: "Linhas de detalhe precisam de parent_reference" });
      return;
    }
    const feeRaw = get("fee_kind").toLowerCase();
    const feeKind = !feeRaw ? null : feeRaw === "gateway" ? "gateway" : feeRaw === "platform" || feeRaw === "smartpay" ? "platform" : undefined;
    if (feeKind === undefined) {
      errors.push({ row: rowNumber, message: "fee_kind inválido (gateway | platform)" });
      return;
    }
    rows.push({
      rowNumber,
      settlementReference,
      paymentReference: get("payment_reference").toUpperCase() || null,
      bankAccountCode: get("bank_account").toUpperCase() || null,
      movementType: mv,
      grossAmountMinor: gross,
      gatewayFeeMinor: gatewayFee,
      platformFeeMinor: platformFee,
      netAmountMinor: net,
      reportedStatus: get("status") || null,
      valueDate,
      lineKind,
      parentReference,
      feeKind,
    });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 50) };
  return { ok: true, rows };
}
