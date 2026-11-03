/**
 * MockPaymentProvider — the ONLY provider enabled in V1.
 *
 * - Never contacts any external system; never sees card numbers.
 * - Deterministic: outcome is chosen by an explicit scenario, or by test phone
 *   numbers for mobile money (…0001 approve, …0002 insufficient funds,
 *   …0003 stays pending, …0004 customer cancels).
 * - Emits HMAC-SHA256-signed webhooks that go through the SAME verification and
 *   processing pipeline a real provider's webhooks would.
 */
import { applyRatePpm } from "@/lib/money";
import { buildSettlementLines, SIMULATED_GATEWAY_FEE_PPM } from "@/lib/settlement/scenarios";
import { hmacSha256Hex, safeEqualHex, sha256Hex } from "@/lib/security/crypto";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  ProviderEvent,
  ProviderMethod,
  ProviderPaymentStatus,
  RefundInput,
  SettlementRequest,
  SignedWebhook,
  WebhookVerification,
} from "./provider";

export const MOCK_SCENARIOS = {
  approve: { label: "Aprovar pagamento", final: "successful" },
  decline: { label: "Recusado pelo emissor", final: "failed" },
  insufficient_funds: { label: "Saldo insuficiente", final: "failed" },
  pending: { label: "Ficar pendente", final: "pending" },
  cancel: { label: "Cliente cancela", final: "cancelled" },
} as const satisfies Record<string, { label: string; final: ProviderPaymentStatus }>;

export type MockScenario = keyof typeof MOCK_SCENARIOS;
export const MOCK_SCENARIO_KEYS = Object.keys(MOCK_SCENARIOS) as MockScenario[];

/** Completing a payment left pending by the "pending" scenario. */
export type PendingResolution = "approve" | "decline" | "cancel";

const PHONE_SCENARIOS: Record<string, MockScenario> = {
  "0001": "approve",
  "0002": "insufficient_funds",
  "0003": "pending",
  "0004": "cancel",
};

export function scenarioFromTestPhone(method: ProviderMethod, phone: string): MockScenario | null {
  if (method === "card") return null;
  return PHONE_SCENARIOS[phone.slice(-4)] ?? null;
}

export const SIGNATURE_HEADER = "x-smartpay-mock-signature";
export const TIMESTAMP_HEADER = "x-smartpay-mock-timestamp";
const MAX_SKEW_SECONDS = 5 * 60;

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly isSimulated = true;

  constructor(
    private readonly secret: string,
    private readonly statusLookup: (providerReference: string) => Promise<ProviderPaymentStatus | null> = async () => null,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!secret || secret.length < 16) throw new Error("MockPaymentProvider requires a webhook secret (>=16 chars)");
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return {
      providerReference: `MOCK-${sha256Hex(`ref:${input.reference}`).slice(0, 20).toUpperCase()}`,
      nextAction: { type: "simulated_checkout" },
    };
  }

  async getPaymentStatus(providerReference: string): Promise<ProviderPaymentStatus | null> {
    return this.statusLookup(providerReference);
  }

  gatewayFee(amountMinor: number, method: ProviderMethod): number {
    return applyRatePpm(amountMinor, SIMULATED_GATEWAY_FEE_PPM[method]);
  }

  /**
   * Produces the signed webhook sequence the simulated provider would send for a
   * checkout outcome. Event ids are deterministic per (payment, step) so that a
   * double-click re-sends the SAME events — and deduplication makes it a no-op.
   */
  simulateCheckout(params: {
    reference: string;
    providerReference: string;
    amountMinor: number;
    method: ProviderMethod;
    scenario: MockScenario;
  }): SignedWebhook[] {
    const out: SignedWebhook[] = [this.sign(this.event(params, "payment.pending", "pending", null))];
    const final = MOCK_SCENARIOS[params.scenario].final;
    if (final === "successful") out.push(this.sign(this.event(params, "payment.succeeded", "successful", null)));
    if (final === "failed")
      out.push(
        this.sign(
          this.event(params, "payment.failed", "failed", params.scenario === "insufficient_funds" ? "INSUFFICIENT_FUNDS" : "DECLINED_BY_ISSUER"),
        ),
      );
    if (final === "cancelled") out.push(this.sign(this.event(params, "payment.cancelled", "cancelled", "CANCELLED_BY_CUSTOMER")));
    return out;
  }

  resolvePending(
    params: { reference: string; providerReference: string; amountMinor: number; method: ProviderMethod },
    resolution: PendingResolution,
  ): SignedWebhook {
    if (resolution === "approve") return this.sign(this.event(params, "payment.succeeded", "successful", null));
    if (resolution === "decline") return this.sign(this.event(params, "payment.failed", "failed", "DECLINED_BY_ISSUER"));
    return this.sign(this.event(params, "payment.cancelled", "cancelled", "TIMEOUT_NO_CUSTOMER_CONFIRMATION"));
  }

  async refundPayment(input: RefundInput): Promise<{ accepted: boolean; signedEvent: SignedWebhook | null }> {
    const event: ProviderEvent = {
      eventId: `mock_evt_${sha256Hex(`${input.paymentReference}:reversed`).slice(0, 24)}`,
      eventType: "payment.reversed",
      providerReference: input.providerReference,
      paymentReference: input.paymentReference,
      status: "reversed",
      amountMinor: input.amountMinor,
      currency: "MZN",
      gatewayFeeMinor: 0,
      providerTransactionId: `mock_tx_${sha256Hex(`${input.paymentReference}:reversal`).slice(0, 20)}`,
      failureReason: input.reason.slice(0, 200),
      occurredAt: this.clock().toISOString(),
    };
    return { accepted: true, signedEvent: this.sign(event) };
  }

  async getSettlementDetails(request: SettlementRequest) {
    return buildSettlementLines(request.scenario, request.batchReference, request.payments);
  }

  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    let raw: unknown = null;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return { valid: false, reason: "malformed", raw: null };
    }
    const signature = headers.get(SIGNATURE_HEADER);
    const timestamp = headers.get(TIMESTAMP_HEADER);
    if (!signature || !timestamp) return { valid: false, reason: "missing_signature", raw };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(this.clock().getTime() / 1000 - ts) > MAX_SKEW_SECONDS) {
      return { valid: false, reason: "stale_timestamp", raw };
    }
    const expected = hmacSha256Hex(this.secret, `${timestamp}.${rawBody}`);
    if (!safeEqualHex(expected, signature)) return { valid: false, reason: "bad_signature", raw };
    const event = parseEvent(raw);
    if (!event) return { valid: false, reason: "malformed", raw };
    return { valid: true, event, raw };
  }

  /** Signs a body exactly as the transport would deliver it. Exposed for tests. */
  sign(event: ProviderEvent): SignedWebhook {
    const rawBody = JSON.stringify(event);
    const timestamp = String(Math.floor(this.clock().getTime() / 1000));
    return {
      rawBody,
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: hmacSha256Hex(this.secret, `${timestamp}.${rawBody}`),
        [TIMESTAMP_HEADER]: timestamp,
      },
    };
  }

  private event(
    p: { reference: string; providerReference: string; amountMinor: number; method: ProviderMethod },
    type: ProviderEvent["eventType"],
    status: ProviderPaymentStatus,
    failureReason: string | null,
  ): ProviderEvent {
    const successful = status === "successful";
    return {
      eventId: `mock_evt_${sha256Hex(`${p.reference}:${type}`).slice(0, 24)}`,
      eventType: type,
      providerReference: p.providerReference,
      paymentReference: p.reference,
      status,
      amountMinor: p.amountMinor,
      currency: "MZN",
      gatewayFeeMinor: successful ? this.gatewayFee(p.amountMinor, p.method) : 0,
      providerTransactionId: successful ? `mock_tx_${sha256Hex(`${p.reference}:charge`).slice(0, 20)}` : null,
      failureReason,
      occurredAt: this.clock().toISOString(),
    };
  }
}

const EVENT_TYPES = new Set(["payment.pending", "payment.succeeded", "payment.failed", "payment.cancelled", "payment.reversed"]);
const STATUSES = new Set(["created", "pending", "successful", "failed", "cancelled", "reversed"]);

function parseEvent(raw: unknown): ProviderEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : null);
  if (!str("eventId") || !EVENT_TYPES.has(str("eventType") ?? "") || !STATUSES.has(str("status") ?? "")) return null;
  if (!str("providerReference") || !str("paymentReference") || !str("occurredAt")) return null;
  if (!Number.isSafeInteger(e.amountMinor) || !Number.isSafeInteger(e.gatewayFeeMinor)) return null;
  return {
    eventId: str("eventId")!,
    eventType: str("eventType") as ProviderEvent["eventType"],
    providerReference: str("providerReference")!,
    paymentReference: str("paymentReference")!,
    status: str("status") as ProviderPaymentStatus,
    amountMinor: e.amountMinor as number,
    currency: str("currency") ?? "MZN",
    gatewayFeeMinor: e.gatewayFeeMinor as number,
    providerTransactionId: str("providerTransactionId"),
    failureReason: str("failureReason"),
    occurredAt: str("occurredAt")!,
  };
}
