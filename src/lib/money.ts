/**
 * Money utilities — dependency-free and floating-point-free.
 *
 * All amounts are integers in MINOR units (centavos: 1 MZN = 100 minor).
 * Rates are integers in parts-per-million (ppm): 0.5% = 5_000 ppm.
 * Multiplication/division happens in BigInt so no precision is ever lost.
 */

export const MINOR_PER_MAJOR = 100;
export const PPM_SCALE = 1_000_000;
export const MAX_PAYMENT_MINOR = 100_000_000_00; // 100 million MZN per payment (demo cap)

export class MoneyError extends Error {}

export function assertMinor(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${label} must be a safe integer in minor units`);
  return value;
}

/**
 * Parses a user-entered MZN amount ("10000", "10 000,50", "10,000.50", "1.250,75")
 * into integer minor units WITHOUT using floating point. Returns null if invalid.
 */
export function parseMznToMinor(input: string): number | null {
  const s = input.trim().replace(/[\s ]/g, "").replace(/MZN|MT/gi, "");
  if (!s || /[^0-9.,]/.test(s)) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  let intPart: string;
  let fracPart = "";

  if (hasComma && hasDot) {
    // The right-most separator is the decimal separator; the other groups thousands.
    const decimalSep = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thousandsSep = decimalSep === "," ? "." : ",";
    const idx = s.lastIndexOf(decimalSep);
    const head = s.slice(0, idx);
    fracPart = s.slice(idx + 1);
    if (head.includes(decimalSep)) return null;
    const groups = head.split(thousandsSep);
    if (!groups.every((g, i) => (i === 0 ? /^\d{1,3}$/.test(g) : /^\d{3}$/.test(g)))) return null;
    intPart = groups.join("");
  } else if (hasComma || hasDot) {
    const sep = hasComma ? "," : ".";
    const parts = s.split(sep);
    const last = parts[parts.length - 1] ?? "";
    if (parts.length === 2 && last.length <= 2) {
      // "10,5" / "10.50" -> decimal separator
      intPart = parts[0] ?? "";
      fracPart = last;
    } else if (parts.every((g, i) => (i === 0 ? /^\d{1,3}$/.test(g) : /^\d{3}$/.test(g)))) {
      // "10,000" / "1.250.000" -> thousands separators
      intPart = parts.join("");
    } else {
      return null;
    }
  } else {
    intPart = s;
  }

  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(fracPart)) return null;

  const minor = BigInt(intPart) * 100n + BigInt((fracPart + "00").slice(0, 2));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(minor);
}

export function sumMinor(values: readonly number[]): number {
  let total = 0n;
  for (const v of values) total += BigInt(assertMinor(v));
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError("Total exceeds safe integer range");
  }
  return Number(total);
}

/** Banker's rounding (round-half-to-even) of numerator/denominator in BigInt. */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError("denominator must be positive");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = n / denominator;
  const r = n % denominator;
  const twice = r * 2n;
  let rounded = q;
  if (twice > denominator || (twice === denominator && q % 2n === 1n)) rounded = q + 1n;
  return negative ? -rounded : rounded;
}

/** amount * rate, rate in ppm, result in minor units (half-even rounding). */
export function applyRatePpm(amountMinor: number, ratePpm: number): number {
  assertMinor(amountMinor, "amountMinor");
  if (!Number.isInteger(ratePpm) || ratePpm < 0 || ratePpm > PPM_SCALE) {
    throw new MoneyError("ratePpm must be an integer between 0 and 1,000,000");
  }
  return Number(divRoundHalfEven(BigInt(amountMinor) * BigInt(ratePpm), BigInt(PPM_SCALE)));
}

/** "0.5" (percent) -> 5000 ppm. Accepts up to 4 decimal places of a percent. */
export function percentToPpm(percent: string): number | null {
  const s = percent.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  const ppm = Number(i) * 10_000 + Number((f + "0000").slice(0, 4));
  return ppm <= PPM_SCALE ? ppm : null;
}

export function ppmToPercentString(ppm: number): string {
  const whole = Math.trunc(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Formats minor units as "10 000,00 MZN" (pt-MZ style) without floats. */
export function formatMzn(minor: number, opts: { withCurrency?: boolean } = {}): string {
  const { withCurrency = true } = opts;
  const negative = minor < 0;
  const abs = BigInt(Math.abs(assertMinor(minor)));
  const intStr = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${intStr},${frac}${withCurrency ? " MZN" : ""}`;
}

/** Compact for charts/KPIs: "1,2 M MZN". Display only — never used in calculations. */
export function formatMznCompact(minor: number): string {
  const major = minor / MINOR_PER_MAJOR;
  const abs = Math.abs(major);
  const fmt = (n: number, suffix: string) => `${(major < 0 ? "-" : "") + n.toFixed(1).replace(".", ",")} ${suffix}`;
  if (abs >= 1_000_000) return fmt(abs / 1_000_000, "M MZN");
  if (abs >= 1_000) return fmt(abs / 1_000, "mil MZN");
  return formatMzn(minor);
}

/** Minor units -> plain decimal string "10000.50" (exports / CSV). */
export function minorToDecimalString(minor: number): string {
  const negative = minor < 0;
  const abs = BigInt(Math.abs(assertMinor(minor)));
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
