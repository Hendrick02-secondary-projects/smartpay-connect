-- Assertion helpers for the SQL test suite (loaded before every test file).
CREATE SCHEMA IF NOT EXISTS sqltest;

CREATE OR REPLACE FUNCTION sqltest.expect_error(stmt text, pattern text, label text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ~* pattern THEN
      RAISE NOTICE 'PASS %', label;
      RETURN;
    END IF;
    RAISE EXCEPTION 'FAIL % — wrong error: %', label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL % — statement succeeded but should have failed', label;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sqltest.expect_ok(stmt text, label text) RETURNS void AS $$
BEGIN
  EXECUTE stmt;
  RAISE NOTICE 'PASS %', label;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'FAIL % — %', label, SQLERRM;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION sqltest.expect_eq(actual anyelement, expected anyelement, label text) RETURNS void AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'FAIL % — expected %, got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'PASS %', label;
END;
$$ LANGUAGE plpgsql;
