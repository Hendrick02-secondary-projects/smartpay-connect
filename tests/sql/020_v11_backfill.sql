-- V1.1 migration preserves V1.0 data and backfills allocations + timeline.
\set ON_ERROR_STOP 1
SELECT sqltest.expect_eq((SELECT count(*) FROM payment_intents WHERE organization_id = '00000000-0000-0000-0000-0000000000f0')::int, 4, 'V1.0 payments preserved');
SELECT sqltest.expect_eq((SELECT count(*) FROM commission_entries WHERE organization_id = '00000000-0000-0000-0000-0000000000f0')::int, 4, 'V1.0 ledger preserved');
SELECT sqltest.expect_eq((SELECT reconciliation_state::text FROM settlement_batches WHERE batch_reference = 'FX-SB-1'), 'reconciled', 'V1.0 batch marked as already reconciled');
SELECT sqltest.expect_eq((SELECT reconciled_at FROM settlement_batches WHERE batch_reference = 'FX-SB-1'), (SELECT created_at FROM settlement_batches WHERE batch_reference = 'FX-SB-1'), 'V1.0 batch reconciled_at = import time');
SELECT sqltest.expect_eq((SELECT line_kind::text FROM bank_settlements WHERE settlement_reference = 'FX-SB-1-0001'), 'statement', 'V1.0 settlement lines are statement lines');

-- allocations: one per debit note of successful/reversed payments, none for failed ones
SELECT sqltest.expect_eq((SELECT count(*) FROM kit_allocations WHERE payment_intent_id = '00000000-0000-0000-0000-0000000000f1')::int, 2, 'two NDs -> two allocations');
SELECT sqltest.expect_eq((SELECT string_agg(status::text, ',') FROM kit_allocations WHERE payment_intent_id = '00000000-0000-0000-0000-0000000000f1'), 'pending,pending', 'backfilled allocations start pending');
SELECT sqltest.expect_eq((SELECT status::text FROM kit_allocations WHERE payment_intent_id = '00000000-0000-0000-0000-0000000000f3'), 'voided', 'reversed V1.0 payment -> voided allocation');
SELECT sqltest.expect_eq((SELECT count(*) FROM kit_allocations WHERE payment_intent_id = '00000000-0000-0000-0000-0000000000f4')::int, 0, 'failed payment gets no allocation');

-- timeline
SELECT sqltest.expect_eq((SELECT count(*) FROM lifecycle_events WHERE payment_intent_id = '00000000-0000-0000-0000-0000000000f1')::int, 8, 'reconciled+invoiced+collected payment has 8 events');
SELECT sqltest.expect_eq((SELECT string_agg(DISTINCT stage::text, ',' ORDER BY stage::text) FROM lifecycle_events WHERE payment_intent_id = '00000000-0000-0000-0000-0000000000f1'),
  'commission_accrual,commission_collection,commission_invoicing,kit_allocation,payment,reconciliation,settlement', 'all reached stages are on the timeline');
SELECT sqltest.expect_eq((SELECT count(*) FROM lifecycle_events WHERE metadata->>'eventId' = 'fx-e1-dup')::int, 0, 'ignored provider deliveries are not timeline events');
SELECT sqltest.expect_eq((SELECT count(*) FROM lifecycle_events WHERE organization_id <> (SELECT organization_id FROM payment_intents p WHERE p.id = lifecycle_events.payment_intent_id))::int, 0, 'every event belongs to its payment''s tenant');

-- idempotent: once caught up (later fixtures may add rows), running it again adds nothing
SELECT smartpay_backfill_v11();
SELECT sqltest.expect_eq(smartpay_backfill_v11(), '{"events": 0, "allocations": 0}'::jsonb, 'backfill is idempotent');
SELECT sqltest.expect_error($$UPDATE lifecycle_events SET summary = 'x'$$, 'append-only', 'timeline UPDATE blocked');
SELECT sqltest.expect_error($$DELETE FROM lifecycle_events$$, 'append-only', 'timeline DELETE blocked');
