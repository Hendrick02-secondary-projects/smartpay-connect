import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomBytesArray(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

/** IPs are never stored in clear text — only a salted hash (privacy + log hygiene). */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return sha256Hex(`${process.env.IP_HASH_SALT ?? "smartpay"}:${ip}`);
}
