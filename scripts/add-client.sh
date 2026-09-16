#!/usr/bin/env bash
# Interactive: add or update a client (Telegram chat ↔ Facebook Page / Instagram account + brand profile).
# Re-running with the same chat ID updates the client. Leave the token blank to keep the stored one.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

ask() { local prompt="$1" default="${2:-}" reply; read -rp "$prompt${default:+ [$default]}: " reply; echo "${reply:-$default}"; }

echo "== Client =="
NAME=$(ask "Business name")
CHAT_ID=$(ask "Telegram chat ID (the bot replies with it)")
FB_PAGE_ID=$(ask "Facebook Page ID")
IG_USER_ID=$(ask "Instagram business account ID (blank if none)")
read -rsp "Page access token (input hidden, blank = keep existing): " PAGE_TOKEN; echo
TIMEZONE=$(ask "Timezone (IANA name, e.g. Africa/Lagos, Europe/London)" "UTC")

echo; echo "== Brand profile =="
BUSINESS=$(ask "What the business does (one or two sentences)")
AUDIENCE=$(ask "Target audience")
VOICE=$(ask "Brand voice" "Friendly, clear and professional")
LANGUAGE=$(ask "Post language" "English")
CTA=$(ask "Default call to action (e.g. 'Order on WhatsApp: +234...')")
HASHTAGS=$(ask "Brand hashtags, comma separated (e.g. #mybakery,#lagosfood)")
BANNED=$(ask "Words to never use, comma separated")

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "${APP_DB_NAME:-smapp}" \
  -v name="$NAME" -v chat_id="$CHAT_ID" -v fb_page_id="$FB_PAGE_ID" -v ig_user_id="$IG_USER_ID" \
  -v page_token="$PAGE_TOKEN" -v enc_key="$TOKEN_ENCRYPTION_KEY" -v timezone="$TIMEZONE" \
  -v business="$BUSINESS" -v audience="$AUDIENCE" -v voice="$VOICE" -v language="$LANGUAGE" \
  -v cta="$CTA" -v hashtags="$HASHTAGS" -v banned="$BANNED" \
  -f /app-sql/add_client.sql
