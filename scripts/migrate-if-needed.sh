#!/bin/sh
set -euo pipefail

SCHEMA_NAME=${MIGRATION_CHECK_SCHEMA:-public}
TABLE_NAME=${MIGRATION_CHECK_TABLE:-Url}

echo "[migrate] Checking for table ${SCHEMA_NAME}.${TABLE_NAME}"

# Returns 't' if table exists, 'f' otherwise
TABLE_EXISTS=$(psql "$DATABASE_URL" -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='${SCHEMA_NAME}' AND table_name='${TABLE_NAME}');")

if [ "$TABLE_EXISTS" = "t" ]; then
  echo "[migrate] Table ${SCHEMA_NAME}.${TABLE_NAME} already exists, skipping prisma migrate deploy"
else
  echo "[migrate] Table ${SCHEMA_NAME}.${TABLE_NAME} not found, running prisma migrate deploy"
  pnpm prisma migrate deploy
fi
