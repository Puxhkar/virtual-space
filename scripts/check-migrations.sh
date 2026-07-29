#!/usr/bin/env bash
# Proves a brand-new environment can be created from the migrations alone.
# Uses a throwaway database so it cannot disturb dev or test data.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="vo_migration_check_$$"
PGC=(docker exec vo-postgres psql -U vo -d postgres -qtA)

cleanup() { "${PGC[@]}" -c "drop database if exists \"$DB\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${PGC[@]}" -c "create database \"$DB\"" >/dev/null

cd apps/server
DATABASE_URL="postgres://vo:vo_local_dev_only@localhost:5432/$DB" \
  pnpm exec drizzle-kit migrate >/dev/null

count=$(docker exec vo-postgres psql -U vo -d "$DB" -qtA -c \
  "select count(*) from information_schema.tables where table_schema='public'")

# 12 domain tables plus drizzle's migration bookkeeping.
if [[ "$count" -lt 12 ]]; then
  echo "expected at least 12 tables, found $count"
  exit 1
fi
echo "$count tables created from migrations"
