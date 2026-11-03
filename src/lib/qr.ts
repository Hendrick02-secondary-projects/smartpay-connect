import "server-only";
import QRCode from "qrcode";
import { paymentPortalUrl as portalUrl } from "./portal";

export function paymentPortalUrl(orgSlug: string): string {
  return portalUrl(process.env.APP_URL ?? "http://localhost:3000", orgSlug);
}

/** Permanent QR for a tenant portal — it encodes a fixed URL, never a payment amount. */
export function portalQrSvg(orgSlug: string): Promise<string> {
  return QRCode.toString(paymentPortalUrl(orgSlug), {
    type: "svg",
    errorCorrectionLevel: "H",
    margin: 1,
    color: { dark: "#1a1416", light: "#ffffff" },
  });
}
