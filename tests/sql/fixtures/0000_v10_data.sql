-- Representative data as written by V1.0 (loaded right after migration 0000, BEFORE 0001),
-- used to prove that 0001 preserves existing data and backfills allocations + timeline.
-- Fixed UUIDs: org ...f0, payments ...f1 (reconciled, 2 NDs), ...f2 (successful, unreconciled),
-- ...f3 (reversed), ...f4 (failed). A second tenant ...e0 owns payment ...e1.

INSERT INTO organizations(id,slug,name,portal_name) VALUES
  ('00000000-0000-0000-0000-0000000000f0','fx-insurer','Fixture Insurer','FX Payments'),
  ('00000000-0000-0000-0000-0000000000e0','fx-other','Fixture Other','Other Payments');
INSERT INTO users(id,organization_id,email,name,password_hash) VALUES
  ('00000000-0000-0000-0000-000000000f01','00000000-0000-0000-0000-0000000000f0','fx-finance@test','FX Finance','x'),
  ('00000000-0000-0000-0000-000000000f02',NULL,'fx-owner@test','FX Owner','x'),
  ('00000000-0000-0000-0000-000000000e01','00000000-0000-0000-0000-0000000000e0','other-finance@test','Other Finance','x');
INSERT INTO user_roles(user_id,role,organization_id) VALUES
  ('00000000-0000-0000-0000-000000000f01','finance_user','00000000-0000-0000-0000-0000000000f0'),
  ('00000000-0000-0000-0000-000000000f02','platform_owner',NULL),
  ('00000000-0000-0000-0000-000000000e01','finance_user','00000000-0000-0000-0000-0000000000e0');
INSERT INTO bank_accounts(id,organization_id,code,bank_name,account_name,account_number_masked,purpose) VALUES
  ('00000000-0000-0000-0000-0000000000fa','00000000-0000-0000-0000-0000000000f0','FX-01','Banco','Conta','DEMO 1','Auto'),
  ('00000000-0000-0000-0000-0000000000ea','00000000-0000-0000-0000-0000000000e0','OT-01','Banco','Conta','DEMO 9','Auto');

INSERT INTO payment_intents(id,organization_id,reference,idempotency_key,request_hash,client_secret_hash,bank_account_id,customer_name,customer_phone,payment_method,amount_minor,status,reconciliation_status,provider,provider_reference,completed_at,created_at) VALUES
  ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f0','FX-PAY-1','f1',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000fa','Ana Machava','+258841234567','card',1000000,'successful','reconciled','mock','MOCK-FX-1','2026-10-01 10:01+02','2026-10-01 10:00+02'),
  ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000f0','FX-PAY-2','f2',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000fa','Carlos Cossa','+258841234568','mpesa',250000,'successful','unreconciled','mock','MOCK-FX-2','2026-10-02 10:01+02','2026-10-02 10:00+02'),
  ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000f0','FX-PAY-3','f3',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000fa','Rosa Tembe','+258841234569','emola',80000,'reversed','unreconciled','mock','MOCK-FX-3','2026-10-03 10:01+02','2026-10-03 10:00+02'),
  ('00000000-0000-0000-0000-0000000000f4','00000000-0000-0000-0000-0000000000f0','FX-PAY-4','f4',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000fa','João Sitoe','+258841234570','card',50000,'failed','unreconciled','mock','MOCK-FX-4','2026-10-04 10:01+02','2026-10-04 10:00+02'),
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e0','OT-PAY-1','e1',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000000ea','Outro Cliente','+258841234571','card',300000,'successful','reconciled','mock','MOCK-OT-1','2026-10-05 10:01+02','2026-10-05 10:00+02');

INSERT INTO payment_debit_notes(id,organization_id,payment_intent_id,debit_note_number,amount_minor,position) VALUES
  ('00000000-0000-0000-0000-00000000f1d1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','DN-FX-1A',650000,1),
  ('00000000-0000-0000-0000-00000000f1d2','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','DN-FX-1B',350000,2),
  ('00000000-0000-0000-0000-00000000f2d1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f2','DN-FX-2A',250000,1),
  ('00000000-0000-0000-0000-00000000f3d1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','DN-FX-3A',80000,1),
  ('00000000-0000-0000-0000-00000000f4d1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f4','DN-FX-4A',50000,1),
  ('00000000-0000-0000-0000-00000000e1d1','00000000-0000-0000-0000-0000000000e0','00000000-0000-0000-0000-0000000000e1','DN-OT-1A',300000,1);

INSERT INTO payment_events(organization_id,payment_intent_id,provider,event_id,event_type,from_status,to_status,signature_valid,processing_status,payload,received_at,processed_at) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','mock','fx-e1','payment.succeeded','pending','successful',true,'processed','{}','2026-10-01 10:01+02','2026-10-01 10:01+02'),
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','mock','fx-e3','payment.succeeded','pending','successful',true,'processed','{}','2026-10-03 10:01+02','2026-10-03 10:01+02'),
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','mock','fx-e3r','payment.reversed','successful','reversed',true,'processed','{}','2026-10-06 10:00+02','2026-10-06 10:00+02'),
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f4','mock','fx-e4','payment.failed','pending','failed',true,'processed','{}','2026-10-04 10:01+02','2026-10-04 10:01+02'),
  -- a duplicate / ignored delivery must NOT become a timeline event
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','mock','fx-e1-dup','payment.succeeded','successful','successful',true,'ignored','{}','2026-10-01 10:02+02','2026-10-01 10:02+02');

INSERT INTO settlement_batches(id,organization_id,batch_reference,source,scenario,row_count,matched_count,exception_count,total_gross_minor,created_by,created_at) VALUES
  ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f0','FX-SB-1','simulated_provider','gross',1,1,0,1000000,'00000000-0000-0000-0000-000000000f01','2026-10-02 18:00+02');
INSERT INTO bank_settlements(id,organization_id,batch_id,settlement_reference,payment_reference,bank_account_code,movement_type,gross_amount_minor,gateway_fee_minor,platform_fee_minor,net_amount_minor,reported_status,value_date,row_number) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b1','FX-SB-1-0001','FX-PAY-1','FX-01','credit',1000000,25000,5000,1000000,'SETTLED','2026-10-02',1);
INSERT INTO reconciliation_records(id,organization_id,batch_id,bank_settlement_id,payment_intent_id,status,reason_code,expected_amount_minor,settled_amount_minor,difference_minor,created_at) VALUES
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000f1','matched','MATCHED',1000000,1000000,0,'2026-10-02 18:00+02');

INSERT INTO commission_rules(id,organization_id,version,rate_ppm,effective_from,status,contract_reference) VALUES
  ('00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-0000000000f0',1,5000,'2026-01-01','active','FX-CTR');
INSERT INTO commission_entries(id,organization_id,payment_intent_id,entry_type,rule_id,rule_version,rate_ppm,base_amount_minor,amount_minor,created_at) VALUES
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','accrual','00000000-0000-0000-0000-0000000000a9',1,5000,1000000,5000,'2026-10-01 10:01+02'),
  ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f2','accrual','00000000-0000-0000-0000-0000000000a9',1,5000,250000,1250,'2026-10-02 10:01+02'),
  ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','accrual','00000000-0000-0000-0000-0000000000a9',1,5000,80000,400,'2026-10-03 10:01+02'),
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f3','reversal','00000000-0000-0000-0000-0000000000a9',1,5000,80000,-400,'2026-10-06 10:00+02');
INSERT INTO commission_invoices(id,organization_id,invoice_number,period_start,period_end,amount_minor,status,issued_at) VALUES
  ('00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000000f0','FX-INV-1','2026-10-01','2026-10-01',5000,'paid','2026-10-10 09:00+02');
INSERT INTO commission_invoice_lines(invoice_id,commission_entry_id,amount_minor) VALUES
  ('00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000000a1',5000);
INSERT INTO commission_payouts(organization_id,invoice_id,amount_minor,received_at,collection_reference,method) VALUES
  ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000a5',5000,'2026-10-20 12:00+02','FX-TRF-1','bank_transfer');
