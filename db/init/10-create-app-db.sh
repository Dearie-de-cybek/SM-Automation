#!/bin/bash
# Runs once, on the first start of an empty Postgres volume.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /app-sql/001_schema.sql
