#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || {
  echo "Missing .env. Copy .env.example to .env and fill in the required values."
  exit 1
}

echo "→ Building and starting SM Automation"
docker compose up -d --build
docker compose ps

echo "→ Stack started"
