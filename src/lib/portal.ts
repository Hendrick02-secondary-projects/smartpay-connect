/**
 * Public payment-portal addressing — PURE (no I/O).
 * Every insurer (organisation) gets its own portal at /pay/<slug>; nothing here is
 * specific to any insurer. The demonstration organisation uses the slug "demo".
 */
export const DEMO_ORG_SLUG = "demo";

export function paymentPortalPath(orgSlug: string): string {
  return `/pay/${encodeURIComponent(orgSlug)}`;
}

/** Absolute URL encoded in an organisation's permanent QR code. */
export function paymentPortalUrl(appUrl: string, orgSlug: string): string {
  return `${appUrl.replace(/\/+$/, "")}${paymentPortalPath(orgSlug)}`;
}
