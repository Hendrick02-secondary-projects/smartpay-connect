import "server-only";
import ExcelJS from "exceljs";
import { mapRows, parseCsv, type ParseResult } from "./parser";

/** Converts an ExcelJS cell value to a plain string without float formatting artefacts. */
function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined) return cellToString(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
  }
  return "";
}

export async function parseSettlementFile(fileName: string, buffer: Buffer): Promise<ParseResult> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return mapRows(parseCsv(buffer.toString("utf8")));
  if (lower.endsWith(".xlsx")) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      return { ok: false, errors: [{ row: 0, message: "Ficheiro Excel inválido ou corrompido." }] };
    }
    const ws = wb.worksheets.find((w) => w.name.toLowerCase().includes("settlement")) ?? wb.worksheets[0];
    if (!ws) return { ok: false, errors: [{ row: 0, message: "O ficheiro não tem folhas." }] };
    const table: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as ExcelJS.CellValue[]; // 1-based
      table.push(values.slice(1).map(cellToString));
    });
    // Skip banner rows above the real header (our exports start with a title row).
    const headerIdx = table.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "settlement_reference"));
    return mapRows(headerIdx >= 0 ? table.slice(headerIdx) : table);
  }
  return { ok: false, errors: [{ row: 0, message: "Formato não suportado. Use .csv ou .xlsx." }] };
}
