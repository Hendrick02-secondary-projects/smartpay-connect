-- Data shaped exactly as the previous demo seed wrote it (former insurer brand), loaded
-- after migration 0001 and BEFORE 0002, to prove 0002 neutralises it without losing data.
-- (The former name must appear here: it is the input of the migration under test.)

INSERT INTO organizations(id,slug,name,portal_name) VALUES
  ('00000000-0000-0000-0000-0000000001a0','hollard','Hollard Moçambique (demo)','Hollard Payments');
INSERT INTO users(id,organization_id,email,name,password_hash) VALUES
  ('00000000-0000-0000-0000-0000000001a1','00000000-0000-0000-0000-0000000001a0','finance@hollard-demo.test','Utilizador Financeiro (demo)','x');
INSERT INTO user_roles(user_id,role,organization_id) VALUES
  ('00000000-0000-0000-0000-0000000001a1','finance_user','00000000-0000-0000-0000-0000000001a0');
INSERT INTO bank_accounts(id,organization_id,code,bank_name,account_name,account_number_masked,purpose) VALUES
  ('00000000-0000-0000-0000-0000000001ab','00000000-0000-0000-0000-0000000001a0','HLD-ALFA-01','Banco Alfa (fictício)','Hollard Demo — Prémios Automóvel','DEMO •••• 1001','Seguro Automóvel');
INSERT INTO commission_rules(id,organization_id,version,rate_ppm,effective_from,status,contract_reference) VALUES
  ('00000000-0000-0000-0000-0000000001ac','00000000-0000-0000-0000-0000000001a0',1,5000,'2026-01-01','active','DEMO-CTR-HOLLARD-001');
INSERT INTO payment_intents(id,organization_id,reference,idempotency_key,request_hash,client_secret_hash,bank_account_id,customer_name,customer_phone,payment_method,amount_minor,status,reconciliation_status,provider,provider_reference,completed_at) VALUES
  ('00000000-0000-0000-0000-0000000001b1','00000000-0000-0000-0000-0000000001a0','HLD-261101-AAAA0001','k-b1',repeat('a',64),repeat('b',64),'00000000-0000-0000-0000-0000000001ab','Ana Machava','+258841234567','mpesa',1000000,'successful','reconciled','mock','MOCK-B1',now());
INSERT INTO payment_debit_notes(id,organization_id,payment_intent_id,debit_note_number,amount_minor,position) VALUES
  ('00000000-0000-0000-0000-0000000001d1','00000000-0000-0000-0000-0000000001a0','00000000-0000-0000-0000-0000000001b1','DN-DEMO-1',1000000,1);
INSERT INTO commission_entries(id,organization_id,payment_intent_id,entry_type,rule_id,rule_version,rate_ppm,base_amount_minor,amount_minor,reason) VALUES
  ('00000000-0000-0000-0000-0000000001e1','00000000-0000-0000-0000-0000000001a0','00000000-0000-0000-0000-0000000001b1','accrual','00000000-0000-0000-0000-0000000001ac',1,5000,1000000,5000,'Comissão contratual v1 sobre pagamento elegível');
INSERT INTO kit_allocations(id,organization_id,payment_intent_id,debit_note_id,notes) VALUES
  ('00000000-0000-0000-0000-0000000001f1','00000000-0000-0000-0000-0000000001a0','00000000-0000-0000-0000-0000000001b1','00000000-0000-0000-0000-0000000001d1','Confirmar no KIT da Hollard antes de alocar');
INSERT INTO lifecycle_events(organization_id,payment_intent_id,stage,event_type,actor_type,summary,metadata,dedupe_key) VALUES
  ('00000000-0000-0000-0000-0000000001a0','00000000-0000-0000-0000-0000000001b1','payment','payment.successful','provider','Pagamento confirmado pelo fornecedor (simulado)','{}','fx-b1-ok'),
  ('00000000-0000-0000-0000-0000000001a0','00000000-0000-0000-0000-0000000001b1','operational_closure','operational.closed','user','Processo operacional Hollard encerrado','{"portal":"Hollard Payments"}','fx-b1-closed');
