-- V1.1 database rules: KIT allocation state machine, closures, aggregated settlement lines.
\set ON_ERROR_STOP 1

-- ---- KIT allocation (payment f1: successful + reconciled; f2: successful, NOT reconciled) ----
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='allocated', receipt_reference='R-1', allocated_on='2026-10-03', allocated_by='00000000-0000-0000-0000-000000000f01', version=version+1
  WHERE payment_intent_id='00000000-0000-0000-0000-0000000000f2'$$, 'requires a successful, reconciled payment', 'cannot allocate before reconciliation');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='allocated', allocated_on='2026-10-03', allocated_by='00000000-0000-0000-0000-000000000f01', version=version+1
  WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$, 'ka_allocated_fields_chk', 'allocation requires a receipt reference');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='allocated', receipt_reference='R-1', allocated_on='2026-10-03', allocated_by='00000000-0000-0000-0000-000000000f01'
  WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$, 'version conflict', 'stale write (no version bump) rejected');
SELECT sqltest.expect_ok($$UPDATE kit_allocations SET status='allocated', receipt_reference='KIT-R-1', allocated_on='2026-10-03', allocated_by='00000000-0000-0000-0000-000000000f01', version=version+1
  WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$, 'first ND allocated');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='allocated', version=version+1 WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$,
  'Invalid KIT allocation transition', 'allocated -> allocated rejected');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='voided', notes='Anulação sem reversão', version=version+1 WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$,
  'only be voided for reversed', 'void requires a reversed payment');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='issue', notes='curta', version=version+1 WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d2'$$,
  'ka_reason_chk', 'issue requires a written reason');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET payment_intent_id='00000000-0000-0000-0000-0000000000f2', version=version+1 WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d2'$$,
  'immutable', 'allocation cannot be moved to another payment');
SELECT sqltest.expect_error($$DELETE FROM kit_allocations WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d2'$$, 'cannot be deleted', 'allocations cannot be deleted');
SELECT sqltest.expect_error($$INSERT INTO kit_allocations(organization_id,payment_intent_id,debit_note_id) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000e1d1')$$,
  'does not match', 'cross-tenant allocation rejected');

-- ---- Operational closure: needs ALL NDs allocated ----
SELECT sqltest.expect_error($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','operational','00000000-0000-0000-0000-000000000f01')$$,
  'every debit note to be allocated in KIT \(1 of 2\)', 'partial allocation blocks operational closure');
SELECT sqltest.expect_ok($$UPDATE kit_allocations SET status='allocated', receipt_reference='KIT-R-2', allocated_on='2026-10-03', allocated_by='00000000-0000-0000-0000-000000000f01', version=version+1
  WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d2'$$, 'second ND allocated');
SELECT sqltest.expect_ok($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','operational','00000000-0000-0000-0000-000000000f01')$$,
  'operational closure once fully allocated (commission status irrelevant)');
SELECT sqltest.expect_error($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','operational','00000000-0000-0000-0000-000000000f01')$$,
  'pc_one_open_per_kind', 'only one open operational closure');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET status='pending', notes='Alocado à apólice errada', version=version+1 WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$,
  'operationally closed', 'closed transaction freezes allocations');
SELECT sqltest.expect_error($$UPDATE payment_closures SET notes='x' WHERE payment_intent_id='00000000-0000-0000-0000-0000000000f1'$$, 'Only reopening', 'closure fields immutable');
SELECT sqltest.expect_error($$UPDATE payment_closures SET reopened_at=now(), reopen_reason='curto' WHERE payment_intent_id='00000000-0000-0000-0000-0000000000f1'$$, 'pc_reopen_reason_chk', 'reopen needs a reason');
SELECT sqltest.expect_ok($$UPDATE payment_closures SET reopened_at=now(), reopened_by='00000000-0000-0000-0000-000000000f01', reopen_reason='Recibo KIT emitido com valor errado'
  WHERE payment_intent_id='00000000-0000-0000-0000-0000000000f1' AND kind='operational'$$, 'closure reopened with reason');
SELECT sqltest.expect_error($$UPDATE payment_closures SET reopen_reason='Outro motivo qualquer' WHERE payment_intent_id='00000000-0000-0000-0000-0000000000f1'$$, 'final', 'reopened closure is final');
SELECT sqltest.expect_ok($$UPDATE kit_allocations SET status='pending', notes='Recibo KIT emitido com valor errado', version=version+1 WHERE debit_note_id='00000000-0000-0000-0000-00000000f1d1'$$,
  'after reopening, allocation can be corrected');
SELECT sqltest.expect_error($$DELETE FROM payment_closures$$, 'cannot be deleted', 'closures cannot be deleted');

-- ---- Financial closure: commission invoiced AND collected ----
SELECT sqltest.expect_ok($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','financial','00000000-0000-0000-0000-000000000f02')$$,
  'financial closure independent of operational closure (commission paid)');
SELECT sqltest.expect_error($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f2','financial','00000000-0000-0000-0000-000000000f02')$$,
  'invoiced and fully collected', 'accrued-but-not-collected commission blocks financial closure');
SELECT sqltest.expect_ok($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','financial','00000000-0000-0000-0000-000000000f02')$$,
  'reversed payment with cancelled-out commission can close financially');
SELECT sqltest.expect_ok($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','operational','00000000-0000-0000-0000-000000000f01')$$,
  'reversed payment with all allocations voided can close operationally');
SELECT sqltest.expect_error($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f4','operational','00000000-0000-0000-0000-000000000f01')$$,
  'Only confirmed payments', 'failed payment cannot be closed');
SELECT sqltest.expect_error($$INSERT INTO payment_closures(organization_id,payment_intent_id,kind,closed_by) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000e1','operational','00000000-0000-0000-0000-000000000f01')$$,
  'does not match', 'cross-tenant closure rejected');

-- ---- Aggregated settlement lines ----
INSERT INTO settlement_batches(id,organization_id,batch_reference,source,scenario,reconciliation_state,fee_treatment)
  VALUES ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000f0','FX-AGG','simulated_provider','aggregated','pending','invoiced_separately');
INSERT INTO bank_settlements(id,organization_id,batch_id,settlement_reference,movement_type,gross_amount_minor,net_amount_minor,value_date,row_number,line_kind)
  VALUES ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b2','FX-AGG-1','credit',330000,330000,'2026-10-07',1,'statement');
SELECT sqltest.expect_ok($$INSERT INTO bank_settlements(organization_id,batch_id,settlement_reference,payment_reference,movement_type,gross_amount_minor,net_amount_minor,value_date,row_number,line_kind,parent_settlement_id)
  VALUES ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b2','FX-AGG-1-D1','FX-PAY-2','credit',250000,250000,'2026-10-07',2,'detail','00000000-0000-0000-0000-0000000000c2')$$,
  'detail line attached to its aggregated credit');
SELECT sqltest.expect_error($$INSERT INTO bank_settlements(organization_id,batch_id,settlement_reference,payment_reference,movement_type,gross_amount_minor,net_amount_minor,value_date,row_number,line_kind)
  VALUES ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b2','FX-AGG-1-D9','FX-PAY-2','credit',1,1,'2026-10-07',3,'detail')$$,
  'bs_detail_parent_chk|aggregated statement credit', 'detail line without parent rejected');
SELECT sqltest.expect_error($$INSERT INTO bank_settlements(organization_id,batch_id,settlement_reference,payment_reference,movement_type,gross_amount_minor,net_amount_minor,value_date,row_number,line_kind,parent_settlement_id)
  VALUES ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b1','FX-AGG-1-D8','FX-PAY-2','credit',1,1,'2026-10-07',3,'detail','00000000-0000-0000-0000-0000000000c2')$$,
  'same batch', 'detail line in another batch rejected');
SELECT sqltest.expect_error($$INSERT INTO bank_settlements(organization_id,batch_id,settlement_reference,payment_reference,movement_type,gross_amount_minor,net_amount_minor,value_date,row_number,line_kind,parent_settlement_id)
  VALUES ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b1','FX-AGG-1-D7','FX-PAY-2','credit',1,1,'2026-10-07',3,'detail','00000000-0000-0000-0000-0000000000c1')$$,
  'aggregated statement credit', 'detail under a non-aggregate (payment) line rejected');
SELECT sqltest.expect_error($$UPDATE bank_settlements SET gross_amount_minor = 1$$, 'append-only', 'settlement lines remain append-only');
SELECT sqltest.expect_error($$UPDATE settlement_batches SET fee_treatment='magic' WHERE batch_reference='FX-AGG'$$, 'sb_fee_treatment_chk', 'fee treatment constrained');
