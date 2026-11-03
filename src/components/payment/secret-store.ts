/**
 * The capability secret for a payment lives only in this browser tab's sessionStorage
 * (never in URLs). It lets the customer re-open their status/confirmation on this device.
 */
const key = (reference: string) => `spc:pay:${reference}`;

export function storeSecret(reference: string, secret: string) {
  try {
    sessionStorage.setItem(key(reference), secret);
  } catch {
    /* storage unavailable (private mode) — the in-memory flow still works */
  }
}

export function readSecret(reference: string): string | null {
  try {
    return sessionStorage.getItem(key(reference));
  } catch {
    return null;
  }
}
