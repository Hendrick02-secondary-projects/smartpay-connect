import bcrypt from "bcryptjs";

const COST = 12;

// Real hash computed once per instance; compared against when the e-mail does not
// exist so that response time does not reveal which accounts exist.
let dummyHash: string | null = null;
function getDummyHash(): string {
  dummyHash ??= bcrypt.hashSync("smartpay-timing-equaliser", COST);
  return dummyHash;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash ?? getDummyHash());
  } catch {
    return false;
  }
}

/** Minimum demo password policy (production should add breach-list checks / MFA). */
export function isStrongPassword(p: string): boolean {
  return p.length >= 12 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);
}
