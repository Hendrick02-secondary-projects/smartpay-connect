import { describe, expect, it } from "vitest";
import {
  applyRatePpm,
  divRoundHalfEven,
  formatMzn,
  minorToDecimalString,
  parseMznToMinor,
  percentToPpm,
  ppmToPercentString,
  sumMinor,
} from "@/lib/money";

describe("parseMznToMinor", () => {
  it("parses plain and decimal inputs without floating point", () => {
    expect(parseMznToMinor("10000")).toBe(1_000_000);
    expect(parseMznToMinor("10000,50")).toBe(1_000_050);
    expect(parseMznToMinor("10000.5")).toBe(1_000_050);
    expect(parseMznToMinor("0,01")).toBe(1);
  });
  it("understands thousands separators", () => {
    expect(parseMznToMinor("10 000,00")).toBe(1_000_000);
    expect(parseMznToMinor("10.000")).toBe(1_000_000);
    expect(parseMznToMinor("1,250,000.75")).toBe(125_000_075);
    expect(parseMznToMinor("1.250.000,75")).toBe(125_000_075);
    expect(parseMznToMinor("10 000 MZN")).toBe(1_000_000);
  });
  it("rejects garbage and over-precise amounts", () => {
    expect(parseMznToMinor("")).toBeNull();
    expect(parseMznToMinor("abc")).toBeNull();
    expect(parseMznToMinor("-5")).toBeNull();
    expect(parseMznToMinor("1,2,3")).toBeNull();
    expect(parseMznToMinor("10.555")).toBe(1_055_500); // interpreted as thousands
    expect(parseMznToMinor("10,5,5")).toBeNull();
  });
  it("avoids the classic 0.1 + 0.2 float error", () => {
    expect(sumMinor([parseMznToMinor("0,10")!, parseMznToMinor("0,20")!])).toBe(30);
  });
});

describe("rates and rounding", () => {
  it("computes 0.5% of 10,000 MZN = 50 MZN exactly", () => {
    expect(applyRatePpm(1_000_000, 5_000)).toBe(5_000);
  });
  it("uses banker's rounding (half-even)", () => {
    expect(divRoundHalfEven(5n, 2n)).toBe(2n); // 2.5 -> 2
    expect(divRoundHalfEven(7n, 2n)).toBe(4n); // 3.5 -> 4
    expect(divRoundHalfEven(-5n, 2n)).toBe(-2n);
    // 0.5% of 1.00 MZN (100 minor) = 0.5 minor -> 0 (half-even)
    expect(applyRatePpm(100, 5_000)).toBe(0);
    // 0.5% of 3.00 MZN = 1.5 minor -> 2
    expect(applyRatePpm(300, 5_000)).toBe(2);
  });
  it("converts percent strings <-> ppm", () => {
    expect(percentToPpm("0.5")).toBe(5_000);
    expect(percentToPpm("0,75")).toBe(7_500);
    expect(percentToPpm("1.2345")).toBe(12_345);
    expect(percentToPpm("1.23456")).toBeNull();
    expect(ppmToPercentString(5_000)).toBe("0.5");
    expect(ppmToPercentString(10_000)).toBe("1");
  });
  it("rejects invalid rates", () => {
    expect(() => applyRatePpm(100, -1)).toThrow();
    expect(() => applyRatePpm(100, 1.5)).toThrow();
  });
});

describe("formatting", () => {
  it("formats MZN in pt-MZ style", () => {
    expect(formatMzn(1_000_000)).toBe("10 000,00 MZN");
    expect(formatMzn(-5_000, { withCurrency: false })).toBe("-50,00");
    expect(minorToDecimalString(1_000_050)).toBe("10000.50");
    expect(minorToDecimalString(-7)).toBe("-0.07");
  });
});
