#!/bin/bash
# Runs once, on the first start of an empty Postgres volume.
# n8n keeps its own data in $POSTGRES_DB; the app data lives in a separate database.
set -euo pipefail

APP_DB="${APP_DB_NAME:-smapp}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE \"$APP_DB\";"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$APP_DB" \
  -f /app-sql/001_schema.sql
