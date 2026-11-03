-- ROLLBACK of drizzle/0002_neutral_identity.sql — restores every value saved in "rebrand_backup".
-- Usage (inside one transaction):  psql "$DATABASE_URL" --single-transaction -f drizzle/rollback/0002_neutral_identity.down.sql
-- It also removes the migration's record from drizzle.__drizzle_migrations so it can be re-applied later.

DO $$
DECLARE b record; restored int := 0;
BEGIN
  IF to_regclass('public.rebrand_backup') IS NULL THEN
    RAISE NOTICE 'Nothing to roll back: rebrand_backup does not exist';
    RETURN;
  END IF;

  ALTER TABLE lifecycle_events DISABLE TRIGGER lifecycle_events_append_only;
  ALTER TABLE commission_entries DISABLE TRIGGER commission_entries_append_only;
  ALTER TABLE commission_payouts DISABLE TRIGGER commission_payouts_append_only;
  ALTER TABLE kit_allocations DISABLE TRIGGER kit_allocations_guard;
  ALTER TABLE payment_closures DISABLE TRIGGER payment_closures_guard;

  -- Newest first, so a column changed twice ends with its original value.
  FOR b IN SELECT * FROM rebrand_backup WHERE migration = '0002_neutral_identity' ORDER BY id DESC LOOP
    EXECUTE format('UPDATE %I SET %I = CAST($1 AS %s) WHERE id = $2', b.table_name, b.column_name, b.column_type)
      USING b.old_value, b.row_id;
    restored := restored + 1;
  END LOOP;

  ALTER TABLE lifecycle_events ENABLE TRIGGER lifecycle_events_append_only;
  ALTER TABLE commission_entries ENABLE TRIGGER commission_entries_append_only;
  ALTER TABLE commission_payouts ENABLE TRIGGER commission_payouts_append_only;
  ALTER TABLE kit_allocations ENABLE TRIGGER kit_allocations_guard;
  ALTER TABLE payment_closures ENABLE TRIGGER payment_closures_guard;

  DELETE FROM rebrand_backup WHERE migration = '0002_neutral_identity';

  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1762171200000;
  END IF;

  INSERT INTO audit_logs (actor_type, action, entity_type, metadata)
  VALUES ('system', 'platform.neutral_identity_rolled_back', 'organization', jsonb_build_object('restoredValues', restored));
  RAISE NOTICE 'Restored % value(s)', restored;
END;
$$;
