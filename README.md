# SM Automation

Multi-tenant social media automation for small businesses and agencies. Clients can create, approve, schedule, publish, and manage replies from one dashboard or Telegram.

## Capabilities

- Compose once and publish across supported social channels.
- Schedule posts with a durable PostgreSQL-backed worker.
- Review comments in a unified inbox.
- Generate guarded AI reply suggestions from each business's profile and knowledge base.
- Enable automatic replies per client, with complaints, refunds, legal or medical topics, threats, and uncertain answers routed to a human.
- Build business context from websites, documents, and catalog data.
- Connect Buffer for broad publishing coverage and direct providers where webhooks or comment replies need native APIs.

## Architecture

| Path | Responsibility |
|---|---|
| `apps/dashboard` | Next.js dashboard, API routes, OAuth callbacks, and webhooks |
| `apps/worker` | Scheduled publishing, ingestion, AI generation, and reply jobs |
| `packages/core` | Shared contracts, database access, providers, queues, and business logic |
| `db/migrations` | Idempotent PostgreSQL schema and tenant security |
| `db/sql` | Runtime role provisioning |

PostgreSQL is the system of record and job queue. Dashboard and worker share typed contracts from `@sm/core`. Provider adapters isolate network-specific authentication, publishing, comments, and replies.

## Quick start

Requirements: Node.js 22.12+, npm, Docker, and Docker Compose.

```bash
git clone https://github.com/Dearie-de-cybek/SM-Automation.git
cd SM-Automation
cp .env.example .env
# Fill required secrets and provider credentials in .env
./scripts/setup.sh
```

Local app URL defaults to `http://localhost:3000`. Production deployments should set `APP_URL` and `DASHBOARD_URL` to the public HTTPS dashboard URL.

## Development

```bash
npm install
npm run migrate
npm test
npm run typecheck
npm run build
```

Run services directly from their workspaces when developing:

```bash
npm run dev -w @sm/dashboard
npm run dev -w @sm/worker
```

## Provider strategy

- **Buffer:** default publishing path for wide network coverage. Each customer can connect their own account.
- **Direct providers:** Meta, YouTube, Bluesky, Mastodon, and Telegram support native events and interactions where configured.
- **Meta pilot:** direct Meta connection stays hidden unless `META_DIRECT_ENABLED=true`.

Publishing credentials are encrypted before storage. OAuth state is short-lived and one-use. Webhooks preserve raw payloads for signature verification and deduplication.

## AI replies

Automatic replies are disabled by default. Deterministic policy checks run before model generation. High-risk, ambiguous, or low-confidence messages become human-review tasks. Per-client limits and plan controls cap usage.

## Operations

```bash
docker compose ps
docker compose logs -f dashboard worker
docker compose up -d --build
docker compose down
```

Back up PostgreSQL and `.env` together. Losing `TOKEN_ENCRYPTION_KEY` makes stored provider credentials unreadable.
