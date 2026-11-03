-- Migration 0002: former insurer brand removed from persisted data, nothing lost, fully reversible.
\set ON_ERROR_STOP 1

-- 1. No text/json column outside the backup and the audit log mentions the former name.
CREATE TEMP TABLE brand_hits AS SELECT 0 AS n;
DO $$
DECLARE c record; hits int; total int := 0;
BEGIN
  FOR c IN SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'character', 'jsonb')
              AND table_name NOT IN ('rebrand_backup', 'audit_logs')
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text ~* %L', c.table_name, c.column_name, 'hollard') INTO hits;
    total := total + hits;
  END LOOP;
  UPDATE brand_hits SET n = total;
END $$;
SELECT sqltest.expect_eq((SELECT n FROM brand_hits), 0, 'no persisted value mentions the former brand');

-- 2. Identity replaced as specified.
SELECT sqltest.expect_eq((SELECT slug || '|' || name || '|' || portal_name FROM organizations WHERE id = '00000000-0000-0000-0000-0000000001a0'),
  'demo|Demo Insurance Company|SmartPay Payments', 'organisation is now Demo Insurance Company at /pay/demo');
SELECT sqltest.expect_eq((SELECT email FROM users WHERE id = '00000000-0000-0000-0000-0000000001a1'), 'finance@demo-insurance.test', 'demo finance e-mail neutralised');
SELECT sqltest.expect_eq((SELECT account_name FROM bank_accounts WHERE id = '00000000-0000-0000-0000-0000000001ab'), 'Demo Insurance — Prémios Automóvel', 'bank account name neutralised');
SELECT sqltest.expect_eq((SELECT contract_reference FROM commission_rules WHERE id = '00000000-0000-0000-0000-0000000001ac'), 'DEMO-CTR-INSURER-001', 'contract reference neutralised');
SELECT sqltest.expect_eq((SELECT summary FROM lifecycle_events WHERE dedupe_key = 'fx-b1-closed'), 'Processo operacional da seguradora encerrado', 'timeline summary neutralised');
SELECT sqltest.expect_eq((SELECT metadata->>'portal' FROM lifecycle_events WHERE dedupe_key = 'fx-b1-closed'), 'SmartPay Payments', 'timeline metadata (jsonb) neutralised and still valid JSON');

-- 3. Nothing financial changed, nothing lost.
SELECT sqltest.expect_eq((SELECT reference || '|' || amount_minor || '|' || status || '|' || reconciliation_status FROM payment_intents WHERE id = '00000000-0000-0000-0000-0000000001b1'),
  'HLD-261101-AAAA0001|1000000|successful|reconciled', 'payment reference, amount and states untouched (references are immutable)');
SELECT sqltest.expect_eq((SELECT amount_minor FROM commission_entries WHERE id = '00000000-0000-0000-0000-0000000001e1'), 5000::bigint, 'commission ledger amount untouched');
SELECT sqltest.expect_eq((SELECT code FROM bank_accounts WHERE id = '00000000-0000-0000-0000-0000000001ab'), 'HLD-ALFA-01', 'bank account code (identifier used by settlement history) untouched');
SELECT sqltest.expect_eq((SELECT count(*) FROM payment_intents)::int, 6, 'all payments preserved (5 V1.0 fixture + 1 demo)');
SELECT sqltest.expect_eq((SELECT count(*) FROM lifecycle_events)::int, 24, 'all timeline events preserved');
SELECT sqltest.expect_eq((SELECT status::text || '|' || version FROM kit_allocations WHERE id = '00000000-0000-0000-0000-0000000001f1'), 'pending|1', 'allocation state/version untouched (only the note text changed)');
SELECT sqltest.expect_eq((SELECT count(*) FROM audit_logs WHERE action = 'platform.neutral_identity_applied')::int, 1, 'migration recorded in the audit log');

-- 4. Guards are active again after the migration.
SELECT sqltest.expect_error($$UPDATE lifecycle_events SET summary = 'x'$$, 'append-only', 'timeline append-only guard re-enabled');
SELECT sqltest.expect_error($$UPDATE kit_allocations SET notes = 'x' WHERE id = '00000000-0000-0000-0000-0000000001f1'$$, 'version conflict', 'allocation guard re-enabled');
SELECT sqltest.expect_error($$DELETE FROM commission_entries$$, 'append-only', 'ledger guard re-enabled');

-- 5. Reversible: the rollback script restores every original value.
SELECT sqltest.expect_eq((SELECT count(*) FROM rebrand_backup)::int, 9, 'every changed value backed up (9 values)');
\i drizzle/rollback/0002_neutral_identity.down.sql
SELECT sqltest.expect_eq((SELECT slug || '|' || name || '|' || portal_name FROM organizations WHERE id = '00000000-0000-0000-0000-0000000001a0'),
  'hollard|Hollard Moçambique (demo)|Hollard Payments', 'rollback restores the organisation');
SELECT sqltest.expect_eq((SELECT summary FROM lifecycle_events WHERE dedupe_key = 'fx-b1-closed'), 'Processo operacional Hollard encerrado', 'rollback restores timeline text');
SELECT sqltest.expect_eq((SELECT metadata->>'portal' FROM lifecycle_events WHERE dedupe_key = 'fx-b1-closed'), 'Hollard Payments', 'rollback restores jsonb');
SELECT sqltest.expect_eq((SELECT count(*) FROM rebrand_backup)::int, 0, 'backup consumed by rollback');
SELECT sqltest.expect_error($$UPDATE lifecycle_events SET summary = 'x'$$, 'append-only', 'guards re-enabled after rollback');
