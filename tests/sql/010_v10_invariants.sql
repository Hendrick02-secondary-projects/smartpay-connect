-- V1.0 database invariants (must keep passing after every later migration).
\set ON_ERROR_STOP 1
SET client_min_messages = notice;

INSERT INTO organizations(id,slug,name,portal_name) VALUES ('00000000-0000-0000-0000-0000000000a1','sqlt-a','A','A Pay');
INSERT INTO bank_accounts(id,organization_id,code,bank_name,account_name,account_number_masked,purpose)
  VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','A1','Banco','Conta','DEMO 1','P');
INSERT INTO payment_intents(id,organization_id,reference,idempotency_key,request_hash,client_secret_hash,bank_account_id,customer_name,customer_phone,payment_method,amount_minor,provider,provider_reference)
  VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000a1','SQLT-1','k1',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000b1','Ana','+258841234567','card',1000000,'mock','MOCK-SQLT-1');
INSERT INTO commission_rules(id,organization_id,version,rate_ppm,effective_from,status,contract_reference)
  VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1',1,5000,'2026-01-01','active','C1');

SELECT sqltest.expect_error($$INSERT INTO payment_intents(organization_id,reference,idempotency_key,request_hash,client_secret_hash,bank_account_id,customer_name,customer_phone,payment_method,amount_minor,provider,provider_reference)
  VALUES ('00000000-0000-0000-0000-0000000000a1','SQLT-2','k1',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000b1','Ana','+258841234567','card',1,'mock','MOCK-SQLT-2')$$,
  'payment_intents_idem_uq', 'idempotency key cannot be reused within a tenant');
SELECT sqltest.expect_error($$UPDATE payment_intents SET status='reversed' WHERE reference='SQLT-1'$$, 'Invalid payment status transition', 'created -> reversed blocked');
SELECT sqltest.expect_ok($$UPDATE payment_intents SET status='pending' WHERE reference='SQLT-1'$$, 'created -> pending allowed');
SELECT sqltest.expect_error($$UPDATE payment_intents SET status='created' WHERE reference='SQLT-1'$$, 'Invalid payment status transition', 'pending -> created blocked');
SELECT sqltest.expect_ok($$UPDATE payment_intents SET status='successful' WHERE reference='SQLT-1'$$, 'pending -> successful allowed');
SELECT sqltest.expect_error($$UPDATE payment_intents SET status='failed' WHERE reference='SQLT-1'$$, 'Invalid payment status transition', 'successful -> failed blocked');
SELECT sqltest.expect_error($$UPDATE payment_intents SET amount_minor=1 WHERE reference='SQLT-1'$$, 'immutable', 'payment amount immutable');
SELECT sqltest.expect_error($$DELETE FROM payment_intents WHERE reference='SQLT-1'$$, 'append-only', 'payments cannot be deleted');

SELECT sqltest.expect_ok($$INSERT INTO commission_entries(organization_id,payment_intent_id,entry_type,rule_id,amount_minor)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','accrual','00000000-0000-0000-0000-0000000000d1',5000)$$, 'first accrual accepted');
SELECT sqltest.expect_error($$INSERT INTO commission_entries(organization_id,payment_intent_id,entry_type,rule_id,amount_minor)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','accrual','00000000-0000-0000-0000-0000000000d1',5000)$$,
  'ce_one_accrual_per_payment', 'duplicate accrual blocked');
SELECT sqltest.expect_error($$INSERT INTO commission_entries(organization_id,payment_intent_id,entry_type,amount_minor)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','reversal',5000)$$, 'ce_reversal_negative_chk', 'positive reversal blocked');
SELECT sqltest.expect_error($$UPDATE commission_entries SET amount_minor=1$$, 'append-only', 'ledger UPDATE blocked');
SELECT sqltest.expect_error($$DELETE FROM commission_entries$$, 'append-only', 'ledger DELETE blocked');
SELECT sqltest.expect_ok($$INSERT INTO audit_logs(actor_type,action,entity_type) VALUES ('system','x','y')$$, 'audit insert accepted');
SELECT sqltest.expect_error($$DELETE FROM audit_logs$$, 'append-only', 'audit DELETE blocked');
SELECT sqltest.expect_ok($$UPDATE payment_intents SET status='reversed' WHERE reference='SQLT-1'$$, 'successful -> reversed allowed');
SELECT sqltest.expect_error($$INSERT INTO user_roles(user_id,role,organization_id)
  SELECT u.id,'platform_owner','00000000-0000-0000-0000-0000000000a1' FROM (SELECT gen_random_uuid() id) u$$, 'user_roles_scope_chk|foreign key', 'owner role cannot be tenant-scoped');
