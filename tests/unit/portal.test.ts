import { describe, expect, it } from "vitest";
import { DEMO_ORG_SLUG, paymentPortalPath, paymentPortalUrl } from "@/lib/portal";

describe("payment portal addressing", () => {
  it("the demo organisation's portal and QR code point to /pay/demo", () => {
    expect(DEMO_ORG_SLUG).toBe("demo");
    expect(paymentPortalPath(DEMO_ORG_SLUG)).toBe("/pay/demo");
    expect(paymentPortalUrl("https://smartpay.example/", DEMO_ORG_SLUG)).toBe("https://smartpay.example/pay/demo");
    expect(paymentPortalUrl("http://localhost:3000", DEMO_ORG_SLUG)).toBe("http://localhost:3000/pay/demo");
  });

  it("works for any insurer slug (no tenant is hard-coded)", () => {
    expect(paymentPortalPath("seguradora-x")).toBe("/pay/seguradora-x");
    expect(paymentPortalPath("a b")).toBe("/pay/a%20b");
  });
});
