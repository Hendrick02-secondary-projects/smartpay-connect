/**
 * Drizzle schema — mirrors drizzle/0000_init.sql (the SQL migration is the
 * authoritative DDL; it also contains triggers that Drizzle cannot express:
 * append-only ledgers and the payment state-machine guard).
 *
 * Money: bigint minor units (centavos), mode "number" (safe up to 9e15).
 * Rates: integer parts-per-million (0.5% = 5000 ppm).
 */
import {
  bigint,
  boolean,
  char,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const money = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow().$onUpdate(() => new Date());

export const roleEnum = pgEnum("role", ["finance_user", "finance_admin", "platform_owner"]);
export const paymentMethodEnum = pgEnum("payment_method", ["card", "mpesa", "emola"]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "created",
  "pending",
  "successful",
  "failed",
  "cancelled",
  "reversed",
]);
export const reconciliationStateEnum = pgEnum("reconciliation_state", [
  "unreconciled",
  "reconciled",
  "exception",
  "manually_reconciled",
]);
export const transactionTypeEnum = pgEnum("transaction_type", ["charge", "reversal"]);
export const eventProcessingStatusEnum = pgEnum("event_processing_status", [
  "received",
  "processed",
  "ignored",
  "rejected",
]);
export const settlementSourceEnum = pgEnum("settlement_source", ["simulated_provider", "file_import"]);
export const settlementScenarioEnum = pgEnum("settlement_scenario", [
  "gross",
  "net",
  "separate_fee_debit",
  "aggregated",
  "reversal",
  "file",
]);
export const featureStatusEnum = pgEnum("feature_status", [
  "simulated",
  "not_verified",
  "contractually_confirmed",
  "technically_tested",
]);
export const movementTypeEnum = pgEnum("movement_type", ["credit", "fee_debit", "reversal_debit"]);
export const reconStatusEnum = pgEnum("recon_status", [
  "matched",
  "unmatched",
  "amount_mismatch",
  "duplicate_settlement",
  "under_review",
  "manually_reconciled",
  "rejected",
]);
export const ruleStatusEnum = pgEnum("rule_status", ["active", "superseded", "expired", "draft"]);
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", ["accrual", "adjustment", "reversal"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["issued", "partially_paid", "paid", "void"]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "system", "public", "provider"]);
// V1.1
export const kitAllocationStatusEnum = pgEnum("kit_allocation_status", ["pending", "allocated", "issue", "voided"]);
export const closureKindEnum = pgEnum("closure_kind", ["operational", "financial"]);
export const lifecycleStageEnum = pgEnum("lifecycle_stage", [
  "payment",
  "settlement",
  "reconciliation",
  "kit_allocation",
  "operational_closure",
  "commission_accrual",
  "commission_invoicing",
  "commission_collection",
  "financial_closure",
]);
export const batchReconciliationStateEnum = pgEnum("batch_reconciliation_state", ["pending", "reconciled"]);
export const settlementLineKindEnum = pgEnum("settlement_line_kind", ["statement", "detail"]);
export const feeKindEnum = pgEnum("fee_kind", ["gateway", "platform"]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  portalName: varchar("portal_name", { length: 160 }).notNull(),
  isDemo: boolean("is_demo").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id),
  email: varchar("email", { length: 254 }).notNull().unique(),
  name: varchar("name", { length: 160 }).notNull(),
  passwordHash: varchar("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: ts("locked_until"),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userRoles = pgTable("user_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: roleEnum("role").notNull(),
  organizationId: uuid("organization_id").references(() => organizations.id),
  createdAt: createdAt(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  ipHash: char("ip_hash", { length: 64 }),
  userAgent: varchar("user_agent", { length: 256 }),
  createdAt: createdAt(),
});

export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 200 }).primaryKey(),
  count: integer("count").notNull(),
  windowStart: ts("window_start").notNull(),
});

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    code: varchar("code", { length: 32 }).notNull(),
    bankName: varchar("bank_name", { length: 120 }).notNull(),
    accountName: varchar("account_name", { length: 160 }).notNull(),
    accountNumberMasked: varchar("account_number_masked", { length: 40 }).notNull(),
    purpose: varchar("purpose", { length: 160 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("MZN"),
    isFictional: boolean("is_fictional").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("bank_accounts_org_code_uq").on(t.organizationId, t.code)],
);

export const paymentIntents = pgTable(
  "payment_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    reference: varchar("reference", { length: 40 }).notNull().unique(),
    idempotencyKey: varchar("idempotency_key", { length: 80 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    clientSecretHash: char("client_secret_hash", { length: 64 }).notNull(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    customerName: varchar("customer_name", { length: 160 }).notNull(),
    customerPhone: varchar("customer_phone", { length: 20 }).notNull(),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    amountMinor: money("amount_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("MZN"),
    status: paymentStatusEnum("status").notNull().default("created"),
    reconciliationStatus: reconciliationStateEnum("reconciliation_status").notNull().default("unreconciled"),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerReference: varchar("provider_reference", { length: 80 }),
    simulationScenario: varchar("simulation_scenario", { length: 40 }),
    failureReason: varchar("failure_reason", { length: 200 }),
    isSimulated: boolean("is_simulated").notNull().default(true),
    statusChangedAt: ts("status_changed_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("payment_intents_idem_uq").on(t.organizationId, t.idempotencyKey),
    unique("payment_intents_provider_ref_uq").on(t.provider, t.providerReference),
  ],
);

export const paymentDebitNotes = pgTable(
  "payment_debit_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    paymentIntentId: uuid("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    debitNoteNumber: varchar("debit_note_number", { length: 40 }).notNull(),
    amountMinor: money("amount_minor").notNull(),
    position: smallint("position").notNull(),
    isCustomerEntered: boolean("is_customer_entered").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [unique("pdn_intent_number_uq").on(t.paymentIntentId, t.debitNoteNumber)],
);

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    paymentIntentId: uuid("payment_intent_id")
      .notNull()
      .references(() => paymentIntents.id),
    type: transactionTypeEnum("type").notNull(),
    providerTransactionId: varchar("provider_transaction_id", { length: 80 }).notNull().unique(),
    amountMinor: money("amount_minor").notNull(),
    gatewayFeeMinor: money("gateway_fee_minor").notNull().default(0),
    paymentMethod: paymentMethodEnum("payment_method").notNull(),
    isSimulated: boolean("is_simulated").notNull().default(true),
    processedAt: ts("processed_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("pt_intent_type_uq").on(t.paymentIntentId, t.type)],
);

export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id),
    paymentIntentId: uuid("payment_intent_id").references(() => paymentIntents.id),
    provider: varchar("provider", { length: 32 }).notNull(),
    eventId: varchar("event_id", { length: 100 }).notNull(),
    eventType: varchar("event_type", { length: 60 }).notNull(),
    fromStatus: paymentStatusEnum("from_status"),
    toStatus: paymentStatusEnum("to_status"),
    signatureValid: boolean("signature_valid").notNull(),
    processingStatus: eventProcessingStatusEnum("processing_status").notNull(),
    processingNote: varchar("processing_note", { length: 300 }),
    payload: jsonb("payload").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [unique("pe_provider_event_uq").on(t.provider, t.eventId)],
);

export const settlementBatches = pgTable(
  "settlement_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    batchReference: varchar("batch_reference", { length: 60 }).notNull(),
    source: settlementSourceEnum("source").notNull(),
    scenario: settlementScenarioEnum("scenario").notNull(),
    featureStatus: featureStatusEnum("feature_status").notNull().default("simulated"),
    fileName: varchar("file_name", { length: 200 }),
    fileHash: char("file_hash", { length: 64 }),
    rowCount: integer("row_count").notNull().default(0),
    matchedCount: integer("matched_count").notNull().default(0),
    exceptionCount: integer("exception_count").notNull().default(0),
    totalGrossMinor: money("total_gross_minor").notNull().default(0),
    isSimulated: boolean("is_simulated").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    // V1.1 — provider settlements wait for the Finance team to reconcile them
    reconciliationState: batchReconciliationStateEnum("reconciliation_state").notNull().default("pending"),
    reconciledAt: ts("reconciled_at"),
    reconciledBy: uuid("reconciled_by").references(() => users.id),
    feeTreatment: varchar("fee_treatment", { length: 30 }).notNull().default("invoiced_separately"),
  },
  (t) => [
    unique("sb_org_ref_uq").on(t.organizationId, t.batchReference),
    unique("sb_org_file_uq").on(t.organizationId, t.fileHash),
  ],
);

export const bankSettlements = pgTable("bank_settlements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => settlementBatches.id),
  settlementReference: varchar("settlement_reference", { length: 80 }).notNull(),
  paymentReference: varchar("payment_reference", { length: 40 }),
  bankAccountCode: varchar("bank_account_code", { length: 32 }),
  movementType: movementTypeEnum("movement_type").notNull(),
  grossAmountMinor: money("gross_amount_minor").notNull(),
  gatewayFeeMinor: money("gateway_fee_minor").notNull().default(0),
  platformFeeMinor: money("platform_fee_minor").notNull().default(0),
  netAmountMinor: money("net_amount_minor").notNull(),
  reportedStatus: varchar("reported_status", { length: 30 }),
  valueDate: date("value_date", { mode: "string" }).notNull(),
  rowNumber: integer("row_number").notNull(),
  isDuplicateRow: boolean("is_duplicate_row").notNull().default(false),
  isSimulated: boolean("is_simulated").notNull().default(true),
  createdAt: createdAt(),
  // V1.1 — aggregated credits: "detail" lines point at their "statement" credit
  lineKind: settlementLineKindEnum("line_kind").notNull().default("statement"),
  parentSettlementId: uuid("parent_settlement_id"),
  feeKind: feeKindEnum("fee_kind"),
});

export const reconciliationRecords = pgTable("reconciliation_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => settlementBatches.id),
  bankSettlementId: uuid("bank_settlement_id")
    .notNull()
    .unique("rr_settlement_uq")
    .references(() => bankSettlements.id),
  paymentIntentId: uuid("payment_intent_id").references(() => paymentIntents.id),
  status: reconStatusEnum("status").notNull(),
  reasonCode: varchar("reason_code", { length: 60 }).notNull(),
  expectedAmountMinor: money("expected_amount_minor"),
  settledAmountMinor: money("settled_amount_minor").notNull(),
  differenceMinor: money("difference_minor"),
  reviewReason: varchar("review_reason", { length: 500 }),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  reviewedAt: ts("reviewed_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const commissionRules = pgTable(
  "commission_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    version: integer("version").notNull(),
    ratePpm: integer("rate_ppm").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    effectiveTo: ts("effective_to"),
    status: ruleStatusEnum("status").notNull(),
    contractReference: varchar("contract_reference", { length: 80 }).notNull(),
    notes: varchar("notes", { length: 500 }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("cr_org_version_uq").on(t.organizationId, t.version)],
);

export const commissionEntries = pgTable("commission_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  paymentIntentId: uuid("payment_intent_id").references(() => paymentIntents.id),
  entryType: ledgerEntryTypeEnum("entry_type").notNull(),
  ruleId: uuid("rule_id").references(() => commissionRules.id),
  ruleVersion: integer("rule_version"),
  ratePpm: integer("rate_ppm"),
  baseAmountMinor: money("base_amount_minor"),
  amountMinor: money("amount_minor").notNull(),
  compensatesEntryId: uuid("compensates_entry_id"),
  reason: varchar("reason", { length: 500 }),
  isSimulated: boolean("is_simulated").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
});

export const commissionInvoices = pgTable("commission_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  invoiceNumber: varchar("invoice_number", { length: 40 }).notNull().unique(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  amountMinor: money("amount_minor").notNull(),
  status: invoiceStatusEnum("status").notNull().default("issued"),
  isSimulated: boolean("is_simulated").notNull().default(true),
  issuedAt: ts("issued_at").notNull().defaultNow(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const commissionInvoiceLines = pgTable("commission_invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => commissionInvoices.id),
  commissionEntryId: uuid("commission_entry_id")
    .notNull()
    .unique("cil_entry_uq")
    .references(() => commissionEntries.id),
  amountMinor: money("amount_minor").notNull(),
  createdAt: createdAt(),
});

export const commissionPayouts = pgTable("commission_payouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => commissionInvoices.id),
  amountMinor: money("amount_minor").notNull(),
  receivedAt: ts("received_at").notNull(),
  collectionReference: varchar("collection_reference", { length: 80 }).notNull().unique(),
  method: varchar("method", { length: 40 }).notNull(),
  notes: varchar("notes", { length: 500 }),
  isSimulated: boolean("is_simulated").notNull().default(true),
  recordedBy: uuid("recorded_by").references(() => users.id),
  createdAt: createdAt(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id),
  actorType: actorTypeEnum("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: varchar("action", { length: 80 }).notNull(),
  entityType: varchar("entity_type", { length: 60 }).notNull(),
  entityId: varchar("entity_id", { length: 80 }),
  metadata: jsonb("metadata").notNull().default({}),
  ipHash: char("ip_hash", { length: 64 }),
  createdAt: createdAt(),
});

// ------------------------------------------------------------------ V1.1
export const kitAllocations = pgTable("kit_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  paymentIntentId: uuid("payment_intent_id")
    .notNull()
    .references(() => paymentIntents.id),
  debitNoteId: uuid("debit_note_id")
    .notNull()
    .unique()
    .references(() => paymentDebitNotes.id),
  status: kitAllocationStatusEnum("status").notNull().default("pending"),
  receiptReference: varchar("receipt_reference", { length: 40 }),
  allocatedOn: date("allocated_on", { mode: "string" }),
  allocatedBy: uuid("allocated_by").references(() => users.id),
  notes: varchar("notes", { length: 500 }),
  updatedBy: uuid("updated_by").references(() => users.id),
  version: integer("version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const paymentClosures = pgTable("payment_closures", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  paymentIntentId: uuid("payment_intent_id")
    .notNull()
    .references(() => paymentIntents.id),
  kind: closureKindEnum("kind").notNull(),
  closedAt: ts("closed_at").notNull().defaultNow(),
  closedBy: uuid("closed_by")
    .notNull()
    .references(() => users.id),
  notes: varchar("notes", { length: 500 }),
  reopenedAt: ts("reopened_at"),
  reopenedBy: uuid("reopened_by").references(() => users.id),
  reopenReason: varchar("reopen_reason", { length: 500 }),
  createdAt: createdAt(),
});

export const lifecycleEvents = pgTable("lifecycle_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  paymentIntentId: uuid("payment_intent_id")
    .notNull()
    .references(() => paymentIntents.id),
  debitNoteId: uuid("debit_note_id").references(() => paymentDebitNotes.id),
  stage: lifecycleStageEnum("stage").notNull(),
  eventType: varchar("event_type", { length: 60 }).notNull(),
  actorType: actorTypeEnum("actor_type").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  summary: varchar("summary", { length: 300 }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  isSimulated: boolean("is_simulated").notNull().default(true),
  dedupeKey: varchar("dedupe_key", { length: 160 }).unique(),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
  createdAt: createdAt(),
});

export type LifecycleStage = (typeof lifecycleStageEnum.enumValues)[number];
export type KitAllocationStatus = (typeof kitAllocationStatusEnum.enumValues)[number];
export type PaymentStatus = (typeof paymentStatusEnum.enumValues)[number];
export type PaymentMethod = (typeof paymentMethodEnum.enumValues)[number];
export type Role = (typeof roleEnum.enumValues)[number];
export type ReconStatus = (typeof reconStatusEnum.enumValues)[number];
export type SettlementScenario = (typeof settlementScenarioEnum.enumValues)[number];
export type FeatureStatus = (typeof featureStatusEnum.enumValues)[number];
