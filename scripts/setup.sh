#!/usr/bin/env bash
# First-time setup (and re-import after changes) on the server.
#   ./scripts/setup.sh                 credentials + workflows, then start everything
#   ./scripts/setup.sh --credentials   credentials only
#   ./scripts/setup.sh --workflows     workflows only (OVERWRITES edits made in the n8n UI)
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Missing .env. Copy .env.example to .env and fill it in."; exit 1; }
set -a; . ./.env; set +a

for var in N8N_DOMAIN DASHBOARD_DOMAIN SESSION_SECRET TELEGRAM_BOT_USERNAME N8N_ENCRYPTION_KEY POSTGRES_PASSWORD \
           APP_DB_USER APP_DB_PASSWORD OPERATOR_DB_USER OPERATOR_DB_PASSWORD WORKER_DB_USER WORKER_DB_PASSWORD N8N_DB_USER N8N_DB_PASSWORD \
           TELEGRAM_BOT_TOKEN GEMINI_API_KEY \
           TOKEN_ENCRYPTION_KEY S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY MEDIA_PUBLIC_BASE_URL; do
  [ -n "${!var:-}" ] || { echo "Missing $var in .env"; exit 1; }
done

MODE="${1:-all}"
CMD=""
add_step() { CMD="${CMD:+$CMD && }$1"; }
if [ "$MODE" = "all" ] || [ "$MODE" = "--credentials" ]; then
  add_step "node /bootstrap/render-credentials.js > /tmp/credentials.json"
  add_step "n8n import:credentials --input=/tmp/credentials.json"
fi
if [ "$MODE" = "all" ] || [ "$MODE" = "--workflows" ]; then
  add_step "n8n import:workflow --separate --input=/workflows"
fi
[ -n "$CMD" ] || { echo "Unknown option: $MODE"; exit 1; }

echo "→ Starting Postgres"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d n8n >/dev/null 2>&1; do sleep 2; done

echo "→ Importing into n8n"
# Secrets that only the import needs are passed to a throwaway container, not the long-running one.
docker compose run --rm --no-deps \
  -e GEMINI_API_KEY -e S3_ENDPOINT -e S3_REGION -e S3_ACCESS_KEY_ID -e S3_SECRET_ACCESS_KEY \
  -e WORKER_DB_USER -e WORKER_DB_PASSWORD \
  --entrypoint sh n8n -c "$CMD"

echo "→ Building dashboard, starting n8n + dashboard + Caddy"
docker compose up -d --build

cat <<EOF

Done. Next:
  1. Open https://${N8N_DOMAIN} and create the n8n owner account (first visit only).
  2. Activate/publish all five "SM ·" workflows (Router and Scheduler must be active).
  3. Send /dashboard to your bot from ADMIN_TELEGRAM_CHAT_ID to open the admin dashboard.
  4. Clients sign up at https://${DASHBOARD_DOMAIN}/signup (or create invite links in Admin).
EOF
