-- SmartPay Connect V1.0 — initial schema
-- All money columns are BIGINT minor units (centavos). No floating point anywhere.
-- Commission rates are INTEGER parts-per-million (0.5% = 5000 ppm).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TYPE "role" AS ENUM ('finance_user', 'finance_admin', 'platform_owner');
--> statement-breakpoint
CREATE TYPE "payment_method" AS ENUM ('card', 'mpesa', 'emola');
--> statement-breakpoint
CREATE TYPE "payment_status" AS ENUM ('created', 'pending', 'successful', 'failed', 'cancelled', 'reversed');
--> statement-breakpoint
CREATE TYPE "reconciliation_state" AS ENUM ('unreconciled', 'reconciled', 'exception', 'manually_reconciled');
--> statement-breakpoint
CREATE TYPE "transaction_type" AS ENUM ('charge', 'reversal');
--> statement-breakpoint
CREATE TYPE "event_processing_status" AS ENUM ('received', 'processed', 'ignored', 'rejected');
--> statement-breakpoint
CREATE TYPE "settlement_source" AS ENUM ('simulated_provider', 'file_import');
--> statement-breakpoint
CREATE TYPE "settlement_scenario" AS ENUM ('gross', 'net', 'separate_fee_debit', 'aggregated', 'reversal', 'file');
--> statement-breakpoint
CREATE TYPE "feature_status" AS ENUM ('simulated', 'not_verified', 'contractually_confirmed', 'technically_tested');
--> statement-breakpoint
CREATE TYPE "movement_type" AS ENUM ('credit', 'fee_debit', 'reversal_debit');
--> statement-breakpoint
CREATE TYPE "recon_status" AS ENUM ('matched', 'unmatched', 'amount_mismatch', 'duplicate_settlement', 'under_review', 'manually_reconciled', 'rejected');
--> statement-breakpoint
CREATE TYPE "rule_status" AS ENUM ('active', 'superseded', 'expired', 'draft');
--> statement-breakpoint
CREATE TYPE "ledger_entry_type" AS ENUM ('accrual', 'adjustment', 'reversal');
--> statement-breakpoint
CREATE TYPE "invoice_status" AS ENUM ('issued', 'partially_paid', 'paid', 'void');
--> statement-breakpoint
CREATE TYPE "actor_type" AS ENUM ('user', 'system', 'public', 'provider');
--> statement-breakpoint

CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug" varchar(64) NOT NULL UNIQUE,
  "name" varchar(160) NOT NULL,
  "portal_name" varchar(160) NOT NULL,
  "is_demo" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "email" varchar(254) NOT NULL UNIQUE,
  "name" varchar(160) NOT NULL,
  "password_hash" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "failed_login_count" integer NOT NULL DEFAULT 0,
  "locked_until" timestamptz,
  "last_login_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"))
);
--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" ("organization_id");
--> statement-breakpoint

CREATE TABLE "user_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" "role" NOT NULL,
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- tenant roles must be bound to an organization; platform owner must not be.
  CONSTRAINT "user_roles_scope_chk" CHECK (
    ("role" = 'platform_owner' AND "organization_id" IS NULL) OR
    ("role" <> 'platform_owner' AND "organization_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_unique" ON "user_roles" ("user_id", "role", COALESCE("organization_id", '00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint

CREATE TABLE "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" char(64) NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "ip_hash" char(64),
  "user_agent" varchar(256),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" ("expires_at");
--> statement-breakpoint

CREATE TABLE "rate_limits" (
  "key" varchar(200) PRIMARY KEY,
  "count" integer NOT NULL,
  "window_start" timestamptz NOT NULL
);
--> statement-breakpoint

CREATE TABLE "bank_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "code" varchar(32) NOT NULL,
  "bank_name" varchar(120) NOT NULL,
  "account_name" varchar(160) NOT NULL,
  "account_number_masked" varchar(40) NOT NULL,
  "purpose" varchar(160) NOT NULL,
  "currency" char(3) NOT NULL DEFAULT 'MZN',
  "is_fictional" boolean NOT NULL DEFAULT true,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "bank_accounts_org_code_uq" UNIQUE ("organization_id", "code")
);
--> statement-breakpoint

CREATE TABLE "payment_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "reference" varchar(40) NOT NULL UNIQUE,
  "idempotency_key" varchar(80) NOT NULL,
  "request_hash" char(64) NOT NULL,
  -- SHA-256 of the capability secret given to the paying customer (status / receipt access).
  "client_secret_hash" char(64) NOT NULL,
  "bank_account_id" uuid NOT NULL REFERENCES "bank_accounts"("id") ON DELETE RESTRICT,
  "customer_name" varchar(160) NOT NULL,
  "customer_phone" varchar(20) NOT NULL,
  "payment_method" "payment_method" NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "currency" char(3) NOT NULL DEFAULT 'MZN',
  "status" "payment_status" NOT NULL DEFAULT 'created',
  "reconciliation_status" "reconciliation_state" NOT NULL DEFAULT 'unreconciled',
  "provider" varchar(32) NOT NULL,
  "provider_reference" varchar(80),
  "simulation_scenario" varchar(40),
  "failure_reason" varchar(200),
  "is_simulated" boolean NOT NULL DEFAULT true,
  "status_changed_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_intents_idem_uq" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "payment_intents_provider_ref_uq" UNIQUE ("provider", "provider_reference")
);
--> statement-breakpoint
CREATE INDEX "pi_org_created_idx" ON "payment_intents" ("organization_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "pi_org_status_idx" ON "payment_intents" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX "pi_org_recon_idx" ON "payment_intents" ("organization_id", "reconciliation_status");
--> statement-breakpoint
CREATE INDEX "pi_org_method_idx" ON "payment_intents" ("organization_id", "payment_method");
--> statement-breakpoint
CREATE INDEX "pi_org_account_idx" ON "payment_intents" ("organization_id", "bank_account_id");
--> statement-breakpoint
CREATE INDEX "pi_customer_name_idx" ON "payment_intents" ("organization_id", lower("customer_name"));
--> statement-breakpoint

CREATE TABLE "payment_debit_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid NOT NULL REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "debit_note_number" varchar(40) NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "position" smallint NOT NULL,
  "is_customer_entered" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pdn_intent_number_uq" UNIQUE ("payment_intent_id", "debit_note_number")
);
--> statement-breakpoint
CREATE INDEX "pdn_org_number_idx" ON "payment_debit_notes" ("organization_id", "debit_note_number");
--> statement-breakpoint

CREATE TABLE "payment_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid NOT NULL REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "type" "transaction_type" NOT NULL,
  "provider_transaction_id" varchar(80) NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "gateway_fee_minor" bigint NOT NULL DEFAULT 0 CHECK ("gateway_fee_minor" >= 0),
  "payment_method" "payment_method" NOT NULL,
  "is_simulated" boolean NOT NULL DEFAULT true,
  "processed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pt_provider_tx_uq" UNIQUE ("provider_transaction_id"),
  -- At most one charge and one reversal per payment intent.
  CONSTRAINT "pt_intent_type_uq" UNIQUE ("payment_intent_id", "type")
);
--> statement-breakpoint
CREATE INDEX "pt_org_processed_idx" ON "payment_transactions" ("organization_id", "processed_at" DESC);
--> statement-breakpoint

CREATE TABLE "payment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "provider" varchar(32) NOT NULL,
  "event_id" varchar(100) NOT NULL,
  "event_type" varchar(60) NOT NULL,
  "from_status" "payment_status",
  "to_status" "payment_status",
  "signature_valid" boolean NOT NULL,
  "processing_status" "event_processing_status" NOT NULL,
  "processing_note" varchar(300),
  "payload" jsonb NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  CONSTRAINT "pe_provider_event_uq" UNIQUE ("provider", "event_id")
);
--> statement-breakpoint
CREATE INDEX "pe_intent_idx" ON "payment_events" ("payment_intent_id", "received_at");
--> statement-breakpoint

CREATE TABLE "settlement_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "batch_reference" varchar(60) NOT NULL,
  "source" "settlement_source" NOT NULL,
  "scenario" "settlement_scenario" NOT NULL,
  "feature_status" "feature_status" NOT NULL DEFAULT 'simulated',
  "file_name" varchar(200),
  "file_hash" char(64),
  "row_count" integer NOT NULL DEFAULT 0,
  "matched_count" integer NOT NULL DEFAULT 0,
  "exception_count" integer NOT NULL DEFAULT 0,
  "total_gross_minor" bigint NOT NULL DEFAULT 0,
  "is_simulated" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sb_org_ref_uq" UNIQUE ("organization_id", "batch_reference"),
  CONSTRAINT "sb_org_file_uq" UNIQUE ("organization_id", "file_hash")
);
--> statement-breakpoint
CREATE INDEX "sb_org_created_idx" ON "settlement_batches" ("organization_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "bank_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "batch_id" uuid NOT NULL REFERENCES "settlement_batches"("id") ON DELETE RESTRICT,
  "settlement_reference" varchar(80) NOT NULL,
  "payment_reference" varchar(40),
  "bank_account_code" varchar(32),
  "movement_type" "movement_type" NOT NULL,
  "gross_amount_minor" bigint NOT NULL,
  "gateway_fee_minor" bigint NOT NULL DEFAULT 0,
  "platform_fee_minor" bigint NOT NULL DEFAULT 0,
  "net_amount_minor" bigint NOT NULL,
  "reported_status" varchar(30),
  "value_date" date NOT NULL,
  "row_number" integer NOT NULL,
  "is_duplicate_row" boolean NOT NULL DEFAULT false,
  "is_simulated" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- A settlement reference may appear only once as a NON-duplicate row per tenant.
CREATE UNIQUE INDEX "bs_org_ref_uq" ON "bank_settlements" ("organization_id", "settlement_reference") WHERE "is_duplicate_row" = false;
--> statement-breakpoint
CREATE INDEX "bs_org_payment_ref_idx" ON "bank_settlements" ("organization_id", "payment_reference");
--> statement-breakpoint
CREATE INDEX "bs_batch_idx" ON "bank_settlements" ("batch_id");
--> statement-breakpoint

CREATE TABLE "reconciliation_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "batch_id" uuid NOT NULL REFERENCES "settlement_batches"("id") ON DELETE RESTRICT,
  "bank_settlement_id" uuid NOT NULL REFERENCES "bank_settlements"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "status" "recon_status" NOT NULL,
  "reason_code" varchar(60) NOT NULL,
  "expected_amount_minor" bigint,
  "settled_amount_minor" bigint NOT NULL,
  "difference_minor" bigint,
  "review_reason" varchar(500),
  "reviewed_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rr_settlement_uq" UNIQUE ("bank_settlement_id")
);
--> statement-breakpoint
CREATE INDEX "rr_org_status_idx" ON "reconciliation_records" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX "rr_intent_idx" ON "reconciliation_records" ("payment_intent_id");
--> statement-breakpoint
-- A payment can be reconciled (credit matched / manually reconciled) by at most ONE settlement.
-- (A later reversal debit is a separate matched movement with reason REVERSAL_CONFIRMED.)
CREATE UNIQUE INDEX "rr_intent_reconciled_uq" ON "reconciliation_records" ("payment_intent_id")
  WHERE "status" = 'manually_reconciled' OR "reason_code" = 'MATCHED';
--> statement-breakpoint

CREATE TABLE "commission_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "version" integer NOT NULL CHECK ("version" > 0),
  "rate_ppm" integer NOT NULL CHECK ("rate_ppm" >= 0 AND "rate_ppm" <= 100000),
  "effective_from" timestamptz NOT NULL,
  "effective_to" timestamptz,
  "status" "rule_status" NOT NULL,
  "contract_reference" varchar(80) NOT NULL,
  "notes" varchar(500),
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cr_org_version_uq" UNIQUE ("organization_id", "version"),
  CONSTRAINT "cr_dates_chk" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);
--> statement-breakpoint
CREATE INDEX "cr_org_effective_idx" ON "commission_rules" ("organization_id", "effective_from" DESC);
--> statement-breakpoint

CREATE TABLE "commission_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "entry_type" "ledger_entry_type" NOT NULL,
  "rule_id" uuid REFERENCES "commission_rules"("id") ON DELETE RESTRICT,
  "rule_version" integer,
  "rate_ppm" integer,
  "base_amount_minor" bigint,
  "amount_minor" bigint NOT NULL,
  "compensates_entry_id" uuid REFERENCES "commission_entries"("id") ON DELETE RESTRICT,
  "reason" varchar(500),
  "is_simulated" boolean NOT NULL DEFAULT true,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ce_accrual_positive_chk" CHECK ("entry_type" <> 'accrual' OR "amount_minor" >= 0),
  CONSTRAINT "ce_reversal_negative_chk" CHECK ("entry_type" <> 'reversal' OR "amount_minor" <= 0),
  CONSTRAINT "ce_adjustment_reason_chk" CHECK ("entry_type" <> 'adjustment' OR "reason" IS NOT NULL)
);
--> statement-breakpoint
-- Duplicate accrual / reversal prevention at the database level.
CREATE UNIQUE INDEX "ce_one_accrual_per_payment" ON "commission_entries" ("payment_intent_id") WHERE "entry_type" = 'accrual';
--> statement-breakpoint
CREATE UNIQUE INDEX "ce_one_reversal_per_payment" ON "commission_entries" ("payment_intent_id") WHERE "entry_type" = 'reversal';
--> statement-breakpoint
CREATE INDEX "ce_org_created_idx" ON "commission_entries" ("organization_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE "commission_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "invoice_number" varchar(40) NOT NULL UNIQUE,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" >= 0),
  "status" "invoice_status" NOT NULL DEFAULT 'issued',
  "is_simulated" boolean NOT NULL DEFAULT true,
  "issued_at" timestamptz NOT NULL DEFAULT now(),
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE "commission_invoice_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoice_id" uuid NOT NULL REFERENCES "commission_invoices"("id") ON DELETE RESTRICT,
  "commission_entry_id" uuid NOT NULL REFERENCES "commission_entries"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- A ledger entry can be invoiced only once.
  CONSTRAINT "cil_entry_uq" UNIQUE ("commission_entry_id")
);
--> statement-breakpoint
CREATE INDEX "cil_invoice_idx" ON "commission_invoice_lines" ("invoice_id");
--> statement-breakpoint

CREATE TABLE "commission_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "invoice_id" uuid NOT NULL REFERENCES "commission_invoices"("id") ON DELETE RESTRICT,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "received_at" timestamptz NOT NULL,
  "collection_reference" varchar(80) NOT NULL UNIQUE,
  "method" varchar(40) NOT NULL,
  "notes" varchar(500),
  "is_simulated" boolean NOT NULL DEFAULT true,
  "recorded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "cp_invoice_idx" ON "commission_payouts" ("invoice_id");
--> statement-breakpoint

CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "actor_type" "actor_type" NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action" varchar(80) NOT NULL,
  "entity_type" varchar(60) NOT NULL,
  "entity_id" varchar(80),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "ip_hash" char(64),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "al_org_created_idx" ON "audit_logs" ("organization_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX "al_entity_idx" ON "audit_logs" ("entity_type", "entity_id");
--> statement-breakpoint

-- ------------------------------------------------------------------
-- Immutability guards: append-only financial/audit tables.
-- Corrections are compensating entries, never UPDATE/DELETE.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION smartpay_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "commission_entries_append_only" BEFORE UPDATE OR DELETE ON "commission_entries"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER "commission_invoice_lines_append_only" BEFORE UPDATE OR DELETE ON "commission_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER "commission_payouts_append_only" BEFORE UPDATE OR DELETE ON "commission_payouts"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER "bank_settlements_append_only" BEFORE UPDATE OR DELETE ON "bank_settlements"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER "payment_transactions_append_only" BEFORE UPDATE OR DELETE ON "payment_transactions"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER "payment_debit_notes_append_only" BEFORE UPDATE OR DELETE ON "payment_debit_notes"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint

-- Payment status may only move along the allowed state machine (defence in depth;
-- the application enforces the same rules in src/lib/payments/state-machine.ts).
CREATE OR REPLACE FUNCTION smartpay_check_payment_transition() RETURNS trigger AS $$
BEGIN
  -- Core financial fields are immutable after creation.
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.organization_id <> OLD.organization_id
     OR NEW.reference <> OLD.reference OR NEW.bank_account_id <> OLD.bank_account_id
     OR NEW.payment_method <> OLD.payment_method THEN
    RAISE EXCEPTION 'Financial fields of a payment intent are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'created'    AND NEW.status IN ('pending', 'successful', 'failed', 'cancelled')) OR
    (OLD.status = 'pending'    AND NEW.status IN ('successful', 'failed', 'cancelled')) OR
    (OLD.status = 'successful' AND NEW.status = 'reversed')
  ) THEN
    RAISE EXCEPTION 'Invalid payment status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "payment_intents_transition_guard" BEFORE UPDATE ON "payment_intents"
  FOR EACH ROW EXECUTE FUNCTION smartpay_check_payment_transition();
--> statement-breakpoint
CREATE TRIGGER "payment_intents_no_delete" BEFORE DELETE ON "payment_intents"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
