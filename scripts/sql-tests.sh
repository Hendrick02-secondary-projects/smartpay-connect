#!/usr/bin/env bash
# SQL test suite — runs against TEST_DATABASE_URL (the schema is WIPED).
# 1. Applies every migration in drizzle/ in order, each in a single transaction (as the Drizzle migrator does).
# 2. Optionally loads tests/sql/fixtures/*.sql BETWEEN migrations to prove data written by an older
#    version survives and is backfilled (fixture NNNN_*.sql is loaded right after migration NNNN).
# 3. Runs tests/sql/[0-9]*.sql, each in its own transaction that is rolled back.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
URL="${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
if [ "${URL}" = "${DATABASE_URL:-}" ]; then echo "TEST_DATABASE_URL must differ from DATABASE_URL" >&2; exit 1; fi
PSQL=(psql "$URL" -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -c "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS sqltest CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;" 2>/dev/null
for m in drizzle/[0-9]*.sql; do
  tag=$(basename "$m" .sql); idx=${tag%%_*}
  "${PSQL[@]}" --single-transaction -f "$m"
  echo "✓ migration $tag"
  for fx in tests/sql/fixtures/${idx}_*.sql; do
    [ -e "$fx" ] || continue
    "${PSQL[@]}" --single-transaction -f "$fx"
    echo "  ↳ fixture $(basename "$fx") loaded after $tag"
  done
done
"${PSQL[@]}" -f tests/sql/_helpers.sql

pass=0; fail=0
for t in tests/sql/[0-9]*.sql; do
  out=$( { echo "BEGIN;"; cat "$t"; echo "ROLLBACK;"; } | psql "$URL" -X -q -v ON_ERROR_STOP=1 2>&1 ) && ok=1 || ok=0
  p=$(grep -c "PASS " <<<"$out" || true)
  pass=$((pass + p))
  if [ $ok -eq 1 ]; then echo "✓ $(basename "$t"): $p assertions"; else fail=$((fail + 1)); echo "✗ $(basename "$t"): $p passed before failure"; grep -E "FAIL|ERROR" <<<"$out" | head -5; fi
done
echo "SQL tests: $pass assertions passed, $fail file(s) failed"
[ $fail -eq 0 ]
