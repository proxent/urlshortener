#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/restore-db.sh /path/to/baseline.dump

Environment:
  PGHOST        PostgreSQL host (default: 127.0.0.1)
  PGPORT        PostgreSQL port (default: 5432)
  PGUSER        PostgreSQL user (default: postgres)
  PGDATABASE    PostgreSQL database (default: urlshortener)
  PGPASSWORD    PostgreSQL password
  RESET_SCHEMA  Reset the public schema before restore (default: true)

Examples:
  export PGPASSWORD='<db-password>'
  PGDATABASE=urlshortener ./scripts/restore-db.sh /tmp/urlshortener-baseline.dump
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

DUMP_PATH=${1:-}

if [ -z "$DUMP_PATH" ]; then
  echo "[restore] dump path is required" >&2
  usage >&2
  exit 1
fi

if [ ! -f "$DUMP_PATH" ]; then
  echo "[restore] dump file not found: $DUMP_PATH" >&2
  exit 1
fi

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
PGDATABASE=${PGDATABASE:-urlshortener}
RESET_SCHEMA=${RESET_SCHEMA:-true}

PSQL=(
  psql
  -v ON_ERROR_STOP=1
  -h "$PGHOST"
  -p "$PGPORT"
  -U "$PGUSER"
  -d "$PGDATABASE"
)

PG_RESTORE=(
  pg_restore
  -v
  -h "$PGHOST"
  -p "$PGPORT"
  -U "$PGUSER"
  -d "$PGDATABASE"
  --no-owner
  --no-privileges
)

reset_schema() {
  echo "[restore] resetting public schema in ${PGDATABASE}"
  "${PSQL[@]}" <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
SQL
}

restore_custom_dump() {
  echo "[restore] restoring custom dump: $DUMP_PATH"
  "${PG_RESTORE[@]}" --clean --if-exists "$DUMP_PATH"
}

restore_plain_sql() {
  echo "[restore] restoring plain SQL dump: $DUMP_PATH"
  "${PSQL[@]}" -f "$DUMP_PATH"
}

verify_restore() {
  echo "[restore] verifying restore"
  "${PSQL[@]}" -c 'SELECT COUNT(*) AS url_count FROM "Url";'
}

echo "[restore] target=${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"

if [ "$RESET_SCHEMA" = "true" ]; then
  reset_schema
fi

if pg_restore -l "$DUMP_PATH" >/dev/null 2>&1; then
  restore_custom_dump
else
  restore_plain_sql
fi

verify_restore

echo "[restore] completed successfully"
