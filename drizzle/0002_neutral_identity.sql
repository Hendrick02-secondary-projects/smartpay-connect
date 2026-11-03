-- SmartPay Connect — neutral identity (removal of the former demo insurer's brand).
--
-- Controlled and reversible:
--  * only identity/description TEXT is changed (organisation name, slug and portal name,
--    demo bank-account names, demo user e-mail, contract reference, notes and timeline summaries);
--  * every changed value is first copied to "rebrand_backup" (table, row, column, old, new);
--  * drizzle/rollback/0002_neutral_identity.down.sql restores every value from that backup;
--  * amounts, statuses, references, foreign keys and row counts are never touched;
--  * audit_logs are evidence and are NOT rewritten — this migration appends one audit entry instead.
-- Append-only guards are disabled only for the duration of this transaction and re-enabled below.
-- The former name necessarily appears in this file (and in its rollback/test) to be found and replaced.

CREATE TABLE IF NOT EXISTS "rebrand_backup" (
  "id" bigserial PRIMARY KEY,
  "migration" varchar(60) NOT NULL,
  "table_name" varchar(60) NOT NULL,
  "column_name" varchar(60) NOT NULL,
  "column_type" varchar(30) NOT NULL,
  "row_id" uuid NOT NULL,
  "old_value" text,
  "new_value" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Ordered, case-insensitive replacements from the most specific phrase to the bare name.
CREATE FUNCTION pg_temp.neutral_text(v text) RETURNS text AS $$
  SELECT
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(v,
      'Hollard Mo[cç]ambique \(demo\)', 'Demo Insurance Company', 'gi'),
      'Hollard Mo[cç]ambique', 'Demo Insurance Company', 'gi'),
      'Hollard Payments', 'SmartPay Payments', 'gi'),
      'Hollard Finan(ce|ças)', 'Finance Dashboard', 'gi'),
      'Hollard Dashboard', 'SmartPay Finance Dashboard', 'gi'),
      'hollard-demo\.test', 'demo-insurance.test', 'gi'),
      'CTR-HOLLARD', 'CTR-INSURER', 'g'),
      'Processo operacional Hollard', 'Processo operacional da seguradora', 'gi'),
      'Hollard Demo', 'Demo Insurance', 'gi'),
      'Hollard', 'Demo Insurance', 'gi')
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint

-- Backs up and rewrites one column, for rows that still carry the former name only.
CREATE FUNCTION pg_temp.rebrand_column(tbl text, col text) RETURNS int AS $$
DECLARE coltype text; n int;
BEGIN
  SELECT data_type INTO coltype FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = tbl AND column_name = col;
  EXECUTE format(
    'INSERT INTO rebrand_backup (migration, table_name, column_name, column_type, row_id, old_value, new_value)
     SELECT %L, %L, %L, %L, id, %I::text, pg_temp.neutral_text(%I::text) FROM %I WHERE %I::text ~* %L',
    '0002_neutral_identity', tbl, col, coltype, col, col, tbl, col, 'hollard');
  EXECUTE format('UPDATE %I SET %I = CAST(pg_temp.neutral_text(%I::text) AS %s) WHERE %I::text ~* %L', tbl, col, col, coltype, col, 'hollard');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DO $$
DECLARE
  changed jsonb := '{}'::jsonb;
  target record;
  n int;
  org_id uuid;
BEGIN
  -- Organisation slug: "/pay/<old>" becomes "/pay/demo" (only if "demo" is free).
  SELECT id INTO org_id FROM organizations WHERE slug = 'hollard';
  IF org_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM organizations WHERE slug = 'demo') THEN
      RAISE EXCEPTION 'Cannot rename organisation slug to "demo": slug already in use';
    END IF;
    INSERT INTO rebrand_backup (migration, table_name, column_name, column_type, row_id, old_value, new_value)
      VALUES ('0002_neutral_identity', 'organizations', 'slug', 'character varying', org_id, 'hollard', 'demo');
    UPDATE organizations SET slug = 'demo' WHERE id = org_id;
  END IF;

  -- Guards of append-only / state-machine tables are lifted for this transaction only.
  ALTER TABLE lifecycle_events DISABLE TRIGGER lifecycle_events_append_only;
  ALTER TABLE commission_entries DISABLE TRIGGER commission_entries_append_only;
  ALTER TABLE commission_payouts DISABLE TRIGGER commission_payouts_append_only;
  ALTER TABLE kit_allocations DISABLE TRIGGER kit_allocations_guard;
  ALTER TABLE payment_closures DISABLE TRIGGER payment_closures_guard;

  FOR target IN SELECT * FROM (VALUES
      ('organizations', 'name'), ('organizations', 'portal_name'),
      ('bank_accounts', 'account_name'), ('bank_accounts', 'bank_name'), ('bank_accounts', 'purpose'),
      ('users', 'email'), ('users', 'name'),
      ('commission_rules', 'contract_reference'), ('commission_rules', 'notes'),
      ('commission_entries', 'reason'), ('commission_payouts', 'notes'),
      ('reconciliation_records', 'review_reason'), ('settlement_batches', 'file_name'),
      ('kit_allocations', 'notes'), ('payment_closures', 'notes'), ('payment_closures', 'reopen_reason'),
      ('lifecycle_events', 'summary'), ('lifecycle_events', 'metadata')
    ) AS t(tbl, col)
  LOOP
    n := pg_temp.rebrand_column(target.tbl, target.col);
    IF n > 0 THEN changed := changed || jsonb_build_object(target.tbl || '.' || target.col, n); END IF;
  END LOOP;

  ALTER TABLE lifecycle_events ENABLE TRIGGER lifecycle_events_append_only;
  ALTER TABLE commission_entries ENABLE TRIGGER commission_entries_append_only;
  ALTER TABLE commission_payouts ENABLE TRIGGER commission_payouts_append_only;
  ALTER TABLE kit_allocations ENABLE TRIGGER kit_allocations_guard;
  ALTER TABLE payment_closures ENABLE TRIGGER payment_closures_guard;

  INSERT INTO audit_logs (organization_id, actor_type, action, entity_type, metadata)
  VALUES (org_id, 'system', 'platform.neutral_identity_applied', 'organization',
          jsonb_build_object('migration', '0002_neutral_identity', 'changedColumns', changed, 'slugRenamed', org_id IS NOT NULL, 'reversible', true));
END;
$$;
