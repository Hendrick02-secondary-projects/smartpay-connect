import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { paymentIntents } from "@/lib/db/schema";
import { MockPaymentProvider } from "./mock-provider";

/**
 * Real provider adapters are HARD-DISABLED in V1. Enabling one requires, at minimum:
 * signed contract, production credentials in a secrets manager, provider certification
 * results, settlement-file specification, and a security review (see docs/PAYMENT_PROVIDER_GUIDE.md).
 * Flipping an environment variable alone is deliberately NOT enough.
 */
export const REAL_PROVIDERS_ENABLED = false as const;

let mock: MockPaymentProvider | null = null;

export function getPaymentProvider(): MockPaymentProvider {
  const configured = process.env.PAYMENT_PROVIDER ?? "mock";
  if (configured !== "mock" || REAL_PROVIDERS_ENABLED) {
    throw new Error(`Payment provider "${configured}" is not enabled in SmartPay Connect V1 (simulation only).`);
  }
  if (!mock) {
    const secret = process.env.MOCK_WEBHOOK_SECRET;
    if (!secret) throw new Error("MOCK_WEBHOOK_SECRET is not configured");
    mock = new MockPaymentProvider(secret, async (providerReference) => {
      const [row] = await getDb()
        .select({ status: paymentIntents.status })
        .from(paymentIntents)
        .where(eq(paymentIntents.providerReference, providerReference))
        .limit(1);
      return row?.status ?? null;
    });
  }
  return mock;
}
