/**
 * Payment provider abstraction. UI, dashboards and finance logic depend ONLY on
 * this interface — a future authorised provider (card acquirer, M-Pesa, e-Mola
 * aggregator) is added as a new adapter without touching them.
 */
import type { GeneratedLine, ScenarioKey, SettleablePayment } from "@/lib/settlement/scenarios";

export type ProviderMethod = "card" | "mpesa" | "emola";
export type ProviderPaymentStatus = "created" | "pending" | "successful" | "failed" | "cancelled" | "reversed";

export interface CreatePaymentInput {
  reference: string;
  amountMinor: number;
  currency: "MZN";
  method: ProviderMethod;
  customerPhone: string;
}

export interface CreatePaymentResult {
  providerReference: string;
  /** What the customer must do next. Real adapters may return a redirect URL or a USSD push. */
  nextAction: { type: "simulated_checkout" } | { type: "redirect"; url: string } | { type: "mobile_push" };
}

/** Normalised provider event — every adapter maps its own webhook format into this. */
export interface ProviderEvent {
  eventId: string;
  eventType: "payment.pending" | "payment.succeeded" | "payment.failed" | "payment.cancelled" | "payment.reversed";
  providerReference: string;
  paymentReference: string;
  status: ProviderPaymentStatus;
  amountMinor: number;
  currency: string;
  gatewayFeeMinor: number;
  providerTransactionId: string | null;
  failureReason: string | null;
  occurredAt: string;
}

export type WebhookVerification =
  | { valid: true; event: ProviderEvent; raw: unknown }
  | { valid: false; reason: "missing_signature" | "bad_signature" | "stale_timestamp" | "malformed"; raw: unknown };

export interface RefundInput {
  providerReference: string;
  paymentReference: string;
  amountMinor: number;
  reason: string;
}

export interface SettlementRequest {
  batchReference: string;
  scenario: ScenarioKey;
  payments: readonly SettleablePayment[];
}

export interface PaymentProvider {
  readonly name: string;
  readonly isSimulated: boolean;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null>;
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  refundPayment(input: RefundInput): Promise<{ accepted: boolean; signedEvent: SignedWebhook | null }>;
  getSettlementDetails(request: SettlementRequest): Promise<GeneratedLine[]>;
}

/** A webhook exactly as it would arrive over HTTP. */
export interface SignedWebhook {
  rawBody: string;
  headers: Record<string, string>;
}
