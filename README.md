# SM Automation: Telegram-approved social posting + client dashboard

A self-hosted system you own and run for your clients:

- **Telegram bot (n8n):** the client sends a photo and a short brief. Gemini drafts the Facebook and Instagram captions in the client's brand voice, and the bot sends the draft back with buttons. **Nothing is published until the client taps 🚀 or schedules it.**
- **Dashboard (Next.js):** clients sign up, connect Telegram and their Facebook Page, edit their brand profile, and see every post with its photo, status, captions, draft history and live links. You get an admin view of all clients.

```
Client ─ signs up on dashboard ─► taps "Open Telegram" ─► bot links the chat, sends a login link
       ─ Settings: Page ID + Page token (verified against Graph API, stored encrypted) + brand profile

Client (Telegram): photo + "Weekend promo, 20% off pastries"
  ▼
SM · Telegram Router ── photo → R2/S3 (public URL) ── post row: generating
  ▼
SM · Generate Draft ── Gemini (JSON schema) → limits enforced → version saved
  │ preview + [🚀 Publish now] [🕒 Schedule] [✏️ Edit] [🔁 Regenerate] [❌ Discard]
  ▼
Button ──► Router
  ├─ 🚀 → SM · Publish Post ─ Facebook Page (/photos or /feed)
  │                         └ Instagram (container → poll FINISHED → media_publish)
  ├─ 🕒 → "when?" → client timezone → SM · Scheduler publishes it
  ├─ ✏️ → "what should change?" → Generate (v2, v3…)
  ├─ 🔁 → Generate (new angle)
  └─ ❌ → discarded
/dashboard in Telegram → one-time login link to the dashboard
SM · Error Handler → your admin Telegram chat
```

## What's in here

| Path | What it is |
|---|---|
| `docker-compose.yml` | Postgres 16, n8n, dashboard, Caddy (automatic HTTPS) |
| `db/sql/001_schema.sql` | App tables: `clients`, `brand_profiles`, `posts`, `post_versions`, `chat_sessions`, `audit_log`, `login_tokens`, `meta_connect_sessions` |
| `workflows/*.json` | **Generated** n8n workflows. Do not hand-edit. |
| `builder/` | Workflow source: `build.mjs` (nodes and wiring) and `code/**.js` (Code node bodies) |
| `dashboard/` | Next.js 16 app (App Router, Tailwind v4, postgres.js, jose sessions) |
| `scripts/setup.sh` | Imports n8n credentials and workflows, then starts the stack |
| `scripts/add-client.sh` | Operator fallback: add a client from the command line |
| `scripts/get-login-link.mjs` | **Local dev only:** prints a dashboard login URL (hard-coded client and chat ID) |

## Design decisions

- **State lives in Postgres, not in waiting executions.** Buttons carry `p:<action>:<post_id>`, and every action is a conditional `UPDATE … WHERE status IN (…)`. Double taps, stale buttons and races can't double-publish.
- **Retries are idempotent.** Facebook and Instagram post IDs are stored per post, so a retry skips any platform that already succeeded. Publish calls are never auto-retried.
- **Everything is audited.** Approve, schedule, reject and publish outcomes go to `audit_log` and show up in the dashboard's post Activity.
- **Passwordless dashboard.** The bot mints a single-use token (only its SHA-256 is stored, it expires in 15 minutes) and sends it as a URL button. The token is only spent by a POST from the page, so link previews and scanners can't burn it. The session is an HS256 cookie that lasts 30 days.
- **Secrets:**
  - Page tokens are encrypted in the DB (`pgp_sym_encrypt` with `TOKEN_ENCRYPTION_KEY`) and never sent back to the browser.
  - The Publish workflow doesn't store successful executions, since they would contain the decrypted token.
- **AI:** Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash`) with a JSON response schema. Safety blocks, truncation and API errors mark the post `draft_failed` and tell the client to resend the brief.

---

## 1. Prerequisites

1. **VPS** (2 vCPU / 4 GB) with Docker + Docker Compose; ports 80/443 open.
2. **Two domains** pointing at it, e.g. `n8n.yourdomain.com` (Telegram webhooks need public HTTPS) and `app.yourdomain.com` (dashboard).
3. **Telegram bot** from [@BotFather](https://t.me/BotFather): the token and the bot username.
4. **Gemini API key** from aistudio.google.com.
5. **Public media bucket.** Cloudflare R2 works well:
   - Create a bucket and enable public access (custom domain or r2.dev). That URL is `MEDIA_PUBLIC_BASE_URL`.
   - Create an R2 API token with Object Read & Write on the bucket.

## 2. Install

```bash
git clone <your repo> sm-automation && cd sm-automation
cp .env.example .env
nano .env                          # fill every value; secrets: openssl rand -hex 32
chmod +x scripts/*.sh db/init/*.sh
./scripts/setup.sh
```

Then:

1. Open `https://<N8N_DOMAIN>` and create the n8n owner account.
2. Activate/publish all five `SM ·` workflows. **Router** and **Scheduler** must be active.
3. Message the bot once. It replies with your chat ID. Put that in `ADMIN_TELEGRAM_CHAT_ID`, run `docker compose up -d`, then send `/dashboard` to get into the admin view.

> Back up `.env`. `N8N_ENCRYPTION_KEY` unlocks n8n credentials, and `TOKEN_ENCRYPTION_KEY` unlocks the clients' Page tokens.

### Production vs local

The compose file currently **publishes ports 5678 (n8n) and 3000 (dashboard) directly** and defaults `APP_URL` / `DASHBOARD_URL` to `http://localhost:3000`. That's convenient locally, but on a VPS:

- Remove the `ports:` blocks from `n8n` and `dashboard` (Caddy serves them over HTTPS).
- Set in `.env`:
  - `APP_URL=https://<DASHBOARD_DOMAIN>`
  - `DASHBOARD_URL=https://<DASHBOARD_DOMAIN>`

Telegram URL buttons require a public `https://` URL, so login links from the bot only work with a real domain or a tunnel.

## 3. Onboarding a client (no work for you)

1. The client opens `https://<DASHBOARD_DOMAIN>/signup` and enters their business name. Set `SIGNUP_CODE` if you want invite-only signups. In the dashboard's **Admin** view you can also create a client and copy an invite link.
2. They tap **Open Telegram** and press **Start**. The bot links the chat and replies with a dashboard login button.
3. In **Settings → Connections** they enter their **Facebook Page ID** and a **Page access token**:
   - The dashboard checks both against the Graph API.
   - It reads the Page name and the linked Instagram business account automatically.
   - It stores the token encrypted.
4. In **Settings → Brand profile** they describe the business, voice, audience, hashtags and banned words, and paste a few past posts.
5. From then on: photo + brief to the bot, approve, done.

### Getting a Page access token

The token needs `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` and, for Instagram, `instagram_basic` + `instagram_content_publish`. The simplest non-expiring route:

1. Business Settings → Users → **System users** → add one.
2. **Assign assets:** the Page (full control) and the Instagram account.
3. **Generate token** for your Meta app with the permissions above, and expiry set to *Never*.
4. Exchange it for the Page token:

```bash
curl "https://graph.facebook.com/v24.0/<PAGE_ID>?fields=access_token&access_token=<SYSTEM_USER_TOKEN>"
```

The Instagram account must be a Business/Creator account **linked to the Page**.

## 4. How the client uses it

**Telegram**
- A photo with a caption drafts for Facebook + Instagram. Text only drafts a Facebook-only post.
- Commands: `/new <brief>`, `/dashboard` (login link), `/cancel`.
- Draft buttons:
  - 🚀 publish now
  - 🕒 schedule (`18:30`, `tomorrow 9am`, `2026-12-24 18:00`, `+2h`)
  - ✏️ edit
  - 🔁 regenerate
  - ❌ discard

**Dashboard**
- **Posts:** counts for awaiting, scheduled, published (last 30 days) and needs-attention posts. Status tabs, and a photo grid with captions and live links.
- **Post page:** full photo, both captions, errors, dates, draft history with the feedback given, and an activity log.
- **Settings:** Telegram and Facebook connections, brand profile and timezone.
- **Admin** (your chat only): all clients with setup status and post counts, *View* as client, activate/deactivate, create invite links.

## 5. Changing the workflows

```bash
node builder/build.mjs            # regenerates workflows/*.json; validates wiring, $('Node') refs, JS/expression syntax, missing "=" on {{ }}
./scripts/setup.sh --workflows    # re-import (overwrites UI edits to these workflows)
```

Dashboard: `cd dashboard && npm install && npm run typecheck && npm run build`.

## 6. Operations

| Task | How |
|---|---|
| Logs | `docker compose logs -f n8n dashboard` |
| Backup | `docker compose exec postgres pg_dumpall -U n8n > backup.sql`, plus `.env` |
| Who approved a post | dashboard post page → Activity, or `audit_log` |
| Pause a client | Admin → Deactivate |
| Upgrade n8n | set `N8N_VERSION`, then `docker compose pull n8n && docker compose up -d` (take a backup first) |

The scheduler marks posts that have been stuck in `generating` or `publishing` for more than 15 minutes as failed, so they can be retried.

## 7. Limits and known gaps

- **The AI doesn't see the photo.** The Gemini request is text-only, so captions come from the brief alone. Sending the image needs it inlined as base64 (`inlineData`), since Gemini can't fetch a public URL.
- **Instagram image ratio** must be between 4:5 and 1.91:1. Other ratios fail with a clear message.
- **Page tokens are entered manually.** For true self-serve, add "Log in with Facebook" (needs Meta App Review).
- **n8n license:** clients only use Telegram and the dashboard, never the n8n editor. That's fine under the Sustainable Use License.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Bot never answers | Router active? `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo` shows the n8n URL with no `last_error_message`. |
| Login button missing or fails | `DASHBOARD_URL` must be public `https://`. The link is single-use and lasts 15 minutes; send `/dashboard` again. |
| "Couldn't create the draft: the AI service failed" | `GEMINI_API_KEY` credential, `GEMINI_MODEL` name, quota. |
| Instagram "Media download has failed" | Open the image URL in a private window. `MEDIA_PUBLIC_BASE_URL` must be public. |
| `(#200)` / `(#10)` permission errors | Token missing a permission, or the system user isn't assigned the Page or Instagram asset. |
| "Wrong key or corrupt data" | `TOKEN_ENCRYPTION_KEY` changed. Re-enter the Page token in Settings. |
