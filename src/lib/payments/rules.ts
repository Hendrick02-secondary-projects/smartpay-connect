/**
 * Pure business rules for the public payment form (no framework dependencies).
 */
import { MAX_PAYMENT_MINOR, sumMinor } from "@/lib/money";

/**
 * Mozambican mobile numbers: 9 digits starting with 82–87 (optionally prefixed by +258 / 258 / 00258).
 * Returns the canonical E.164 form "+2588XXXXXXXX" or null.
 */
export function normalizeMozPhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, "");
  const m = /^(?:\+258|00258|258)?(8[2-7]\d{7})$/.exec(digits);
  return m ? `+258${m[1]}` : null;
}

/** Debit note numbers: 3–40 chars, letters/digits and - / . only. Normalised to upper-case. */
export function normalizeDebitNoteNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export const DEBIT_NOTE_PATTERN = /^[A-Z0-9][A-Z0-9\-/.]{2,39}$/;
export const MAX_DEBIT_NOTES = 20;

export interface DebitNoteInput {
  number: string;
  amountMinor: number;
}

export type DebitNoteIssue =
  | { code: "none"; index: -1 }
  | { code: "empty"; index: -1 }
  | { code: "too_many"; index: -1 }
  | { code: "invalid_number"; index: number }
  | { code: "non_positive_amount"; index: number }
  | { code: "duplicate_number"; index: number }
  | { code: "total_too_large"; index: -1 };

/** Validates a set of debit notes; returns the first issue found or {code:"none"}. */
export function validateDebitNotes(notes: readonly DebitNoteInput[]): DebitNoteIssue {
  if (notes.length === 0) return { code: "empty", index: -1 };
  if (notes.length > MAX_DEBIT_NOTES) return { code: "too_many", index: -1 };
  const seen = new Set<string>();
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]!;
    const n = normalizeDebitNoteNumber(note.number);
    if (!DEBIT_NOTE_PATTERN.test(n)) return { code: "invalid_number", index: i };
    if (!Number.isSafeInteger(note.amountMinor) || note.amountMinor <= 0) {
      return { code: "non_positive_amount", index: i };
    }
    if (seen.has(n)) return { code: "duplicate_number", index: i };
    seen.add(n);
  }
  if (debitNotesTotal(notes) > MAX_PAYMENT_MINOR) return { code: "total_too_large", index: -1 };
  return { code: "none", index: -1 };
}

export function debitNotesTotal(notes: readonly DebitNoteInput[]): number {
  return sumMinor(notes.map((n) => n.amountMinor));
}

/** Customer name: 3–160 chars, at least two letters, no control chars. */
export function normalizeCustomerName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

export function isValidCustomerName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (name.length < 3 || name.length > 160 || /[\u0000-\u001f<>]/.test(name)) return false;
  return (name.match(/\p{L}/gu) ?? []).length >= 2;
}

/** Prefix of new payment references (SmartPay Connect). Existing references are immutable and keep their original prefix. */
export const PAYMENT_REFERENCE_PREFIX = "SPC";

/** Globally unique, human-readable payment reference: SPC-YYMMDD-XXXXXXXX (Crockford base32). */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generatePaymentReference(prefix: string, now: Date, randomBytes: Uint8Array): string {
  if (randomBytes.length < 8) throw new Error("need >= 8 random bytes");
  const y = String(now.getUTCFullYear()).slice(2);
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 8; i++) suffix += ALPHABET[randomBytes[i]! % 32];
  return `${prefix}-${y}${m}${d}-${suffix}`;
}
