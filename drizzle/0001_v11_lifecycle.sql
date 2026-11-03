-- SmartPay Connect V1.1 — KIT allocation, operational/financial closure, lifecycle events,
-- deferred reconciliation of provider settlements and real aggregated settlements.
-- Purely additive: no V1.0 table, column or row is dropped or rewritten (except two new
-- columns on settlement_batches being initialised for the existing, already-reconciled batches).

CREATE TYPE "kit_allocation_status" AS ENUM ('pending', 'allocated', 'issue', 'voided');
--> statement-breakpoint
CREATE TYPE "closure_kind" AS ENUM ('operational', 'financial');
--> statement-breakpoint
CREATE TYPE "lifecycle_stage" AS ENUM ('payment', 'settlement', 'reconciliation', 'kit_allocation', 'operational_closure', 'commission_accrual', 'commission_invoicing', 'commission_collection', 'financial_closure');
--> statement-breakpoint
CREATE TYPE "batch_reconciliation_state" AS ENUM ('pending', 'reconciled');
--> statement-breakpoint
CREATE TYPE "settlement_line_kind" AS ENUM ('statement', 'detail');
--> statement-breakpoint
CREATE TYPE "fee_kind" AS ENUM ('gateway', 'platform');
--> statement-breakpoint

-- ------------------------------------------------------------------
-- Settlement: deferred reconciliation + aggregated credits
-- ------------------------------------------------------------------
ALTER TABLE "settlement_batches"
  ADD COLUMN "reconciliation_state" "batch_reconciliation_state" NOT NULL DEFAULT 'reconciled',
  ADD COLUMN "reconciled_at" timestamptz,
  ADD COLUMN "reconciled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN "fee_treatment" varchar(30) NOT NULL DEFAULT 'invoiced_separately';
--> statement-breakpoint
-- V1.0 batches were reconciled at import time.
UPDATE "settlement_batches" SET
  "reconciled_at" = "created_at",
  "reconciled_by" = "created_by",
  "fee_treatment" = CASE "scenario" WHEN 'net' THEN 'deducted' WHEN 'separate_fee_debit' THEN 'debited_separately' WHEN 'reversal' THEN 'not_applicable' ELSE 'invoiced_separately' END;
--> statement-breakpoint
ALTER TABLE "settlement_batches" ALTER COLUMN "reconciliation_state" SET DEFAULT 'pending';
--> statement-breakpoint
ALTER TABLE "settlement_batches" ADD CONSTRAINT "sb_fee_treatment_chk"
  CHECK ("fee_treatment" IN ('invoiced_separately', 'deducted', 'debited_separately', 'not_applicable'));
--> statement-breakpoint
CREATE INDEX "sb_org_recon_state_idx" ON "settlement_batches" ("organization_id", "reconciliation_state");
--> statement-breakpoint

ALTER TABLE "bank_settlements"
  ADD COLUMN "line_kind" "settlement_line_kind" NOT NULL DEFAULT 'statement',
  ADD COLUMN "parent_settlement_id" uuid REFERENCES "bank_settlements"("id") ON DELETE RESTRICT,
  ADD COLUMN "fee_kind" "fee_kind";
--> statement-breakpoint
ALTER TABLE "bank_settlements" ADD CONSTRAINT "bs_detail_parent_chk"
  CHECK (("line_kind" = 'statement' AND "parent_settlement_id" IS NULL) OR ("line_kind" = 'detail' AND "parent_settlement_id" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX "bs_parent_idx" ON "bank_settlements" ("parent_settlement_id");
--> statement-breakpoint

-- A detail line must belong to an aggregated STATEMENT credit of the same batch and tenant.
CREATE OR REPLACE FUNCTION smartpay_check_settlement_detail() RETURNS trigger AS $$
DECLARE p RECORD;
BEGIN
  IF NEW.line_kind = 'detail' THEN
    SELECT batch_id, organization_id, line_kind, movement_type, payment_reference INTO p
      FROM bank_settlements WHERE id = NEW.parent_settlement_id;
    IF NOT FOUND OR p.batch_id <> NEW.batch_id OR p.organization_id <> NEW.organization_id
       OR p.line_kind <> 'statement' OR p.movement_type <> 'credit' OR p.payment_reference IS NOT NULL THEN
      RAISE EXCEPTION 'Detail line must belong to an aggregated statement credit of the same batch'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "bank_settlements_detail_guard" BEFORE INSERT ON "bank_settlements"
  FOR EACH ROW EXECUTE FUNCTION smartpay_check_settlement_detail();
--> statement-breakpoint

-- ------------------------------------------------------------------
-- KIT allocation — one row per debit note
-- ------------------------------------------------------------------
CREATE TABLE "kit_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid NOT NULL REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "debit_note_id" uuid NOT NULL UNIQUE REFERENCES "payment_debit_notes"("id") ON DELETE RESTRICT,
  "status" "kit_allocation_status" NOT NULL DEFAULT 'pending',
  "receipt_reference" varchar(40),
  "allocated_on" date,
  "allocated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "notes" varchar(500),
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ka_allocated_fields_chk" CHECK ("status" <> 'allocated' OR ("receipt_reference" IS NOT NULL AND "allocated_on" IS NOT NULL AND "allocated_by" IS NOT NULL)),
  CONSTRAINT "ka_reason_chk" CHECK ("status" NOT IN ('issue', 'voided') OR ("notes" IS NOT NULL AND length("notes") >= 10))
);
--> statement-breakpoint
CREATE INDEX "ka_org_status_idx" ON "kit_allocations" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX "ka_payment_idx" ON "kit_allocations" ("payment_intent_id");
--> statement-breakpoint
CREATE INDEX "ka_receipt_idx" ON "kit_allocations" ("organization_id", "receipt_reference");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION smartpay_check_kit_allocation() RETURNS trigger AS $$
DECLARE pay RECORD; dn RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kit_allocations rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT status, reconciliation_status, organization_id INTO pay FROM payment_intents WHERE id = NEW.payment_intent_id;

  IF TG_OP = 'INSERT' THEN
    SELECT payment_intent_id, organization_id INTO dn FROM payment_debit_notes WHERE id = NEW.debit_note_id;
    IF dn.payment_intent_id <> NEW.payment_intent_id OR dn.organization_id <> NEW.organization_id OR pay.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'Allocation tenant/payment does not match its debit note' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (NEW.status = 'pending' OR (NEW.status = 'voided' AND pay.status = 'reversed')) THEN
      RAISE EXCEPTION 'New allocations start as pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'New allocations start at version 1' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.organization_id <> OLD.organization_id OR NEW.payment_intent_id <> OLD.payment_intent_id OR NEW.debit_note_id <> OLD.debit_note_id THEN
    RAISE EXCEPTION 'Allocation ownership is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Allocation version conflict (expected %, got %)', OLD.version + 1, NEW.version USING ERRCODE = 'serialization_failure';
  END IF;
  IF NOT (
    (OLD.status = 'pending'   AND NEW.status IN ('allocated', 'issue', 'voided')) OR
    (OLD.status = 'issue'     AND NEW.status IN ('allocated', 'pending', 'voided')) OR
    (OLD.status = 'allocated' AND NEW.status IN ('pending', 'voided'))
  ) THEN
    RAISE EXCEPTION 'Invalid KIT allocation transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'allocated' AND NOT (pay.status = 'successful' AND pay.reconciliation_status IN ('reconciled', 'manually_reconciled')) THEN
    RAISE EXCEPTION 'KIT allocation requires a successful, reconciled payment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'voided' AND pay.status <> 'reversed' THEN
    RAISE EXCEPTION 'KIT allocations can only be voided for reversed payments' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM payment_closures c WHERE c.payment_intent_id = NEW.payment_intent_id AND c.kind = 'operational' AND c.reopened_at IS NULL) THEN
    RAISE EXCEPTION 'Transaction is operationally closed: reopen it before changing allocations' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ------------------------------------------------------------------
-- Closures — operational (insurer) and financial (SmartPay), independent
-- ------------------------------------------------------------------
CREATE TABLE "payment_closures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid NOT NULL REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "kind" "closure_kind" NOT NULL,
  "closed_at" timestamptz NOT NULL DEFAULT now(),
  "closed_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "notes" varchar(500),
  "reopened_at" timestamptz,
  "reopened_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reopen_reason" varchar(500),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pc_reopen_reason_chk" CHECK ("reopened_at" IS NULL OR ("reopen_reason" IS NOT NULL AND length("reopen_reason") >= 10))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pc_one_open_per_kind" ON "payment_closures" ("payment_intent_id", "kind") WHERE "reopened_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "pc_org_kind_idx" ON "payment_closures" ("organization_id", "kind", "closed_at" DESC);
--> statement-breakpoint

-- Allocation trigger references payment_closures, so it is attached after the table exists.
CREATE TRIGGER "kit_allocations_guard" BEFORE INSERT OR UPDATE OR DELETE ON "kit_allocations"
  FOR EACH ROW EXECUTE FUNCTION smartpay_check_kit_allocation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION smartpay_check_closure() RETURNS trigger AS $$
DECLARE pay RECORD; total int; allocated int; voided int; entries int; net bigint; invoiced int; paid int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_closures rows cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.reopened_at IS NOT NULL THEN
      RAISE EXCEPTION 'A reopened closure is final; create a new closure instead' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.payment_intent_id <> OLD.payment_intent_id
       OR NEW.kind <> OLD.kind OR NEW.closed_at <> OLD.closed_at OR NEW.closed_by <> OLD.closed_by
       OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.created_at <> OLD.created_at OR NEW.reopened_at IS NULL THEN
      RAISE EXCEPTION 'Only reopening (reopened_at/by/reason) is allowed on a closure' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT: the same rules as src/lib/lifecycle/stages.ts (canCloseOperational / canCloseFinancial)
  SELECT status, reconciliation_status, organization_id INTO pay FROM payment_intents WHERE id = NEW.payment_intent_id;
  IF pay.organization_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'Closure tenant does not match the payment' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.kind = 'operational' THEN
    SELECT count(*), count(*) FILTER (WHERE status = 'allocated'), count(*) FILTER (WHERE status = 'voided')
      INTO total, allocated, voided FROM kit_allocations WHERE payment_intent_id = NEW.payment_intent_id;
    IF pay.status = 'successful' THEN
      IF pay.reconciliation_status NOT IN ('reconciled', 'manually_reconciled') THEN
        RAISE EXCEPTION 'Operational closure requires bank reconciliation' USING ERRCODE = 'check_violation';
      END IF;
      IF total = 0 OR allocated <> total THEN
        RAISE EXCEPTION 'Operational closure requires every debit note to be allocated in KIT (% of %)', allocated, total USING ERRCODE = 'check_violation';
      END IF;
    ELSIF pay.status = 'reversed' THEN
      IF voided <> total THEN
        RAISE EXCEPTION 'Reversed payment: every KIT allocation must be voided before closing' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'Only confirmed payments can be closed' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF pay.status NOT IN ('successful', 'reversed') THEN
      RAISE EXCEPTION 'Only confirmed payments can be closed' USING ERRCODE = 'check_violation';
    END IF;
    SELECT count(*), coalesce(sum(e.amount_minor), 0),
           count(l.id), count(l.id) FILTER (WHERE i.status = 'paid')
      INTO entries, net, invoiced, paid
      FROM commission_entries e
      LEFT JOIN commission_invoice_lines l ON l.commission_entry_id = e.id
      LEFT JOIN commission_invoices i ON i.id = l.invoice_id
     WHERE e.payment_intent_id = NEW.payment_intent_id;
    IF entries = 0 THEN
      RAISE EXCEPTION 'Financial closure requires a commission record' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (paid = entries OR (net = 0 AND invoiced = 0)) THEN
      RAISE EXCEPTION 'Financial closure requires the commission to be invoiced and fully collected' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "payment_closures_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payment_closures"
  FOR EACH ROW EXECUTE FUNCTION smartpay_check_closure();
--> statement-breakpoint

-- ------------------------------------------------------------------
-- Lifecycle events — append-only timeline, idempotent via dedupe_key
-- ------------------------------------------------------------------
CREATE TABLE "lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_intent_id" uuid NOT NULL REFERENCES "payment_intents"("id") ON DELETE RESTRICT,
  "debit_note_id" uuid REFERENCES "payment_debit_notes"("id") ON DELETE RESTRICT,
  "stage" "lifecycle_stage" NOT NULL,
  "event_type" varchar(60) NOT NULL,
  "actor_type" "actor_type" NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "summary" varchar(300) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_simulated" boolean NOT NULL DEFAULT true,
  "dedupe_key" varchar(160) UNIQUE,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "le_payment_idx" ON "lifecycle_events" ("payment_intent_id", "occurred_at");
--> statement-breakpoint
CREATE INDEX "le_org_idx" ON "lifecycle_events" ("organization_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE TRIGGER "lifecycle_events_append_only" BEFORE UPDATE OR DELETE ON "lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION smartpay_forbid_mutation();
--> statement-breakpoint

-- ------------------------------------------------------------------
-- Backfill: rebuilds allocations + timeline for data written by V1.0.
-- Idempotent (dedupe keys / NOT EXISTS), so it is also called by the demo seed.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION smartpay_backfill_v11() RETURNS jsonb AS $$
DECLARE n_alloc int; n_events int; c int;
BEGIN
  INSERT INTO kit_allocations (organization_id, payment_intent_id, debit_note_id, status, notes, created_at, updated_at)
  SELECT dn.organization_id, dn.payment_intent_id, dn.id,
         CASE WHEN p.status = 'reversed' THEN 'voided'::kit_allocation_status ELSE 'pending'::kit_allocation_status END,
         CASE WHEN p.status = 'reversed' THEN 'Pagamento revertido antes da alocação no KIT (dados V1.0).' END,
         coalesce(p.completed_at, p.created_at), coalesce(p.completed_at, p.created_at)
    FROM payment_debit_notes dn
    JOIN payment_intents p ON p.id = dn.payment_intent_id
   WHERE p.status IN ('successful', 'reversed')
     AND NOT EXISTS (SELECT 1 FROM kit_allocations a WHERE a.debit_note_id = dn.id);
  GET DIAGNOSTICS n_alloc = ROW_COUNT;
  n_events := 0;

  -- payment created
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT p.organization_id, p.id, 'payment', 'payment.created', 'public',
         'Pagamento iniciado pelo cliente (' || p.payment_method || ')', jsonb_build_object('amountMinor', p.amount_minor, 'backfill', true),
         p.is_simulated, 'payment:' || p.id || ':created', p.created_at
    FROM payment_intents p
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- provider status changes
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT e.organization_id, e.payment_intent_id, 'payment', 'payment.' || e.to_status, 'provider',
         CASE e.to_status
           WHEN 'pending' THEN 'Fornecedor (simulado) recebeu o pedido de pagamento'
           WHEN 'successful' THEN 'Pagamento confirmado pelo fornecedor (simulado)'
           WHEN 'failed' THEN 'Pagamento recusado pelo fornecedor (simulado)'
           WHEN 'cancelled' THEN 'Pagamento cancelado (simulado)'
           WHEN 'reversed' THEN 'Pagamento revertido pelo fornecedor (simulado)'
           ELSE 'Estado do pagamento: ' || e.to_status END,
         jsonb_build_object('eventId', e.event_id, 'from', e.from_status, 'backfill', true),
         true, 'payment:' || e.payment_intent_id || ':' || e.to_status, coalesce(e.processed_at, e.received_at)
    FROM payment_events e
   WHERE e.processing_status = 'processed' AND e.payment_intent_id IS NOT NULL AND e.organization_id IS NOT NULL AND e.to_status IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- KIT allocations opened when the payment was confirmed
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT p.organization_id, p.id, 'kit_allocation', 'kit.opened', 'system',
         count(a.id) || ' nota(s) de débito por alocar no KIT', jsonb_build_object('debitNotes', count(a.id), 'backfill', true),
         p.is_simulated, 'kit:' || p.id || ':opened', coalesce(p.completed_at, p.created_at)
    FROM payment_intents p JOIN kit_allocations a ON a.payment_intent_id = p.id
   GROUP BY p.id
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- allocations voided because the V1.0 payment had been reversed
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, debit_note_id, stage, event_type, actor_type, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT a.organization_id, a.payment_intent_id, a.debit_note_id, 'kit_allocation', 'kit.voided', 'system',
         'ND ' || dn.debit_note_number || ' anulada (pagamento revertido)', jsonb_build_object('backfill', true),
         true, 'kit:' || a.id || ':v' || a.version, a.created_at
    FROM kit_allocations a JOIN payment_debit_notes dn ON dn.id = a.debit_note_id
   WHERE a.status = 'voided'
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- settlement lines that reference a payment of the same tenant
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT bs.organization_id, p.id, 'settlement',
         CASE bs.movement_type WHEN 'reversal_debit' THEN 'settlement.reversal_debit' ELSE 'settlement.received' END, 'provider',
         CASE bs.movement_type WHEN 'reversal_debit' THEN 'Débito de reversão no extracto (simulado)'
              ELSE 'Liquidação bancária recebida no lote ' || b.batch_reference || ' (simulada)' END,
         jsonb_build_object('batchReference', b.batch_reference, 'settlementReference', bs.settlement_reference, 'scenario', b.scenario,
                            'grossMinor', bs.gross_amount_minor, 'netMinor', bs.net_amount_minor, 'duplicate', bs.is_duplicate_row, 'backfill', true),
         bs.is_simulated, 'settlement:' || bs.id, bs.created_at
    FROM bank_settlements bs
    JOIN settlement_batches b ON b.id = bs.batch_id
    JOIN payment_intents p ON p.organization_id = bs.organization_id AND p.reference = bs.payment_reference
   WHERE bs.payment_reference IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- reconciliation: automatic result, then the human review (if any)
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, actor_user_id, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT r.organization_id, r.payment_intent_id, 'reconciliation',
         CASE WHEN r.reason_code = 'MATCHED' OR r.reason_code = 'REVERSAL_CONFIRMED' THEN 'reconciliation.matched' ELSE 'reconciliation.exception' END,
         CASE WHEN b.created_by IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, b.created_by,
         CASE WHEN r.reason_code = 'MATCHED' THEN 'Reconciliação automática: correspondência encontrada'
              WHEN r.reason_code = 'REVERSAL_CONFIRMED' THEN 'Reversão confirmada no extracto'
              ELSE 'Excepção de reconciliação: ' || r.reason_code END,
         jsonb_build_object('reasonCode', r.reason_code, 'batchReference', b.batch_reference, 'backfill', true),
         true, 'recon:' || r.id || ':initial', r.created_at
    FROM reconciliation_records r JOIN settlement_batches b ON b.id = r.batch_id
   WHERE r.payment_intent_id IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, actor_user_id, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT r.organization_id, r.payment_intent_id, 'reconciliation', 'reconciliation.' || r.status, 'user', r.reviewed_by,
         'Revisão manual: ' || r.status || ' — ' || coalesce(r.review_reason, ''),
         jsonb_build_object('reasonCode', r.reason_code, 'backfill', true),
         true, 'recon:' || r.id || ':' || r.status, r.reviewed_at
    FROM reconciliation_records r
   WHERE r.payment_intent_id IS NOT NULL AND r.reviewed_at IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- commission ledger
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, actor_user_id, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT e.organization_id, e.payment_intent_id, 'commission_accrual', 'commission.' || e.entry_type,
         CASE WHEN e.created_by IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, e.created_by,
         CASE e.entry_type WHEN 'accrual' THEN 'Comissão apurada no ledger'
                           WHEN 'reversal' THEN 'Comissão revertida (entrada compensatória)'
                           ELSE 'Ajuste de comissão: ' || coalesce(e.reason, '') END,
         jsonb_build_object('amountMinor', e.amount_minor, 'ratePpm', e.rate_ppm, 'ruleVersion', e.rule_version, 'backfill', true),
         e.is_simulated, 'commission:' || e.id, e.created_at
    FROM commission_entries e WHERE e.payment_intent_id IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  -- invoicing and collection (one event per payment per invoice / per collection)
  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, actor_user_id, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT DISTINCT ON (i.id, e.payment_intent_id) i.organization_id, e.payment_intent_id, 'commission_invoicing', 'commission.invoiced',
         CASE WHEN i.created_by IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, i.created_by,
         'Comissão incluída na factura ' || i.invoice_number || ' (simulada)',
         jsonb_build_object('invoiceNumber', i.invoice_number, 'backfill', true),
         i.is_simulated, 'invoice:' || i.id || ':' || e.payment_intent_id, i.issued_at
    FROM commission_invoice_lines l
    JOIN commission_entries e ON e.id = l.commission_entry_id
    JOIN commission_invoices i ON i.id = l.invoice_id
   WHERE e.payment_intent_id IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  INSERT INTO lifecycle_events (organization_id, payment_intent_id, stage, event_type, actor_type, actor_user_id, summary, metadata, is_simulated, dedupe_key, occurred_at)
  SELECT DISTINCT ON (po.id, e.payment_intent_id) po.organization_id, e.payment_intent_id, 'commission_collection', 'commission.collected',
         CASE WHEN po.recorded_by IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END, po.recorded_by,
         'Cobrança ' || po.collection_reference || ' registada na factura ' || i.invoice_number || ' (simulada)',
         jsonb_build_object('invoiceNumber', i.invoice_number, 'collectionReference', po.collection_reference, 'backfill', true),
         po.is_simulated, 'payout:' || po.id || ':' || e.payment_intent_id, po.received_at
    FROM commission_payouts po
    JOIN commission_invoices i ON i.id = po.invoice_id
    JOIN commission_invoice_lines l ON l.invoice_id = i.id
    JOIN commission_entries e ON e.id = l.commission_entry_id
   WHERE e.payment_intent_id IS NOT NULL
  ON CONFLICT (dedupe_key) DO NOTHING;
  GET DIAGNOSTICS c = ROW_COUNT; n_events := n_events + c;

  RETURN jsonb_build_object('allocations', n_alloc, 'events', n_events);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
SELECT smartpay_backfill_v11();
