-- 002_platform: multi-tenant social platform (connections, targets, inbox, knowledge,
-- automation, usage). Forward-only and non-destructive: columns and tables are added,
-- constraints are widened, nothing that holds user data is dropped.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- clients: plan + full channel list
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'starter';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS plan_overrides jsonb NOT NULL DEFAULT '{}';

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_plan_valid;
ALTER TABLE clients ADD CONSTRAINT clients_plan_valid CHECK (plan IN ('starter', 'pro', 'agency'));

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_platforms_valid;
ALTER TABLE clients ADD CONSTRAINT clients_platforms_valid CHECK (default_platforms <@ ARRAY[
  'facebook', 'instagram', 'threads', 'x', 'linkedin', 'tiktok', 'youtube', 'pinterest',
  'bluesky', 'mastodon', 'telegram', 'google_business']);

-- ---------------------------------------------------------------------------
-- campaigns (referenced by posts.campaign_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       text NOT NULL,
  brief      text NOT NULL DEFAULT '',
  goal       text NOT NULL DEFAULT '',
  channels   text[] NOT NULL DEFAULT '{}',
  starts_on  date,
  ends_on    date,
  cadence    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_client_idx ON campaigns (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- provider_connections: one row per connected provider account (credentials encrypted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  provider         text NOT NULL,
  label            text,
  credentials_enc  bytea,
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'needs_reauth', 'revoked', 'error')),
  last_error       text,
  token_expires_at timestamptz,
  meta             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_connections_provider_valid
    CHECK (provider IN ('buffer', 'meta', 'bluesky', 'mastodon', 'youtube', 'telegram'))
);
CREATE INDEX IF NOT EXISTS provider_connections_client_idx ON provider_connections (client_id);

-- ---------------------------------------------------------------------------
-- social_accounts: what a connection can publish to / read from
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  connection_id      uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  channel            text NOT NULL,
  external_id        text NOT NULL,
  handle             text,
  display_name       text,
  avatar_url         text,
  -- Account-level secret, e.g. a Meta page token.
  credentials_enc    bytea,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'needs_reauth', 'revoked', 'error')),
  capabilities       jsonb,
  meta               jsonb NOT NULL DEFAULT '{}',
  comments_cursor    text,
  comments_synced_at timestamptz,
  webhook_subscribed boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_accounts_channel_valid CHECK (channel IN (
    'facebook', 'instagram', 'threads', 'x', 'linkedin', 'tiktok', 'youtube', 'pinterest',
    'bluesky', 'mastodon', 'telegram', 'google_business')),
  CONSTRAINT social_accounts_unique UNIQUE (client_id, provider, channel, external_id)
);
CREATE INDEX IF NOT EXISTS social_accounts_client_idx ON social_accounts (client_id);
CREATE INDEX IF NOT EXISTS social_accounts_lookup_idx ON social_accounts (channel, external_id);

-- ---------------------------------------------------------------------------
-- posts: multi-channel media, source and cancellation
-- ---------------------------------------------------------------------------
ALTER TABLE posts ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'telegram';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_url text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS campaign_id uuid;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_source_valid;
ALTER TABLE posts ADD CONSTRAINT posts_source_valid CHECK (source IN ('telegram', 'web', 'ai', 'api'));

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_campaign_id_fkey;
ALTER TABLE posts ADD CONSTRAINT posts_campaign_id_fkey
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;
ALTER TABLE posts ADD CONSTRAINT posts_status_check CHECK (status IN (
  'generating', 'draft_failed', 'pending_approval', 'approved', 'scheduled',
  'publishing', 'published', 'partially_published', 'failed', 'rejected', 'cancelled'));

ALTER TABLE post_versions ADD COLUMN IF NOT EXISTS captions jsonb NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- post_targets: one row per (post, account); the unit of publishing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS post_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id           uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  social_account_id uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  channel           text NOT NULL,
  caption           text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'scheduled', 'queued', 'publishing', 'published', 'failed', 'cancelled')),
  publish_at        timestamptz,
  external_id       text,
  permalink         text,
  error             text,
  error_kind        text,
  attempts          int NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_targets_unique UNIQUE (post_id, social_account_id)
);
CREATE INDEX IF NOT EXISTS post_targets_due_idx ON post_targets (publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS post_targets_in_flight_idx ON post_targets (updated_at) WHERE status IN ('queued', 'publishing');
CREATE INDEX IF NOT EXISTS post_targets_client_idx ON post_targets (client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS post_targets_post_idx ON post_targets (post_id);

-- ---------------------------------------------------------------------------
-- comments + replies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  social_account_id  uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  post_target_id     uuid REFERENCES post_targets(id) ON DELETE SET NULL,
  channel            text NOT NULL,
  external_id        text NOT NULL,
  post_external_id   text,
  parent_external_id text,
  author_external_id text,
  author_name        text,
  author_handle      text,
  text               text NOT NULL DEFAULT '',
  permalink          text,
  remote_created_at  timestamptz,
  is_own             boolean NOT NULL DEFAULT false,
  is_hidden          boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'new' CHECK (status IN (
                       'new', 'triaging', 'needs_review', 'suggested', 'replied',
                       'auto_replied', 'ignored', 'hidden', 'error')),
  classification     jsonb,
  triage_error       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_unique UNIQUE (social_account_id, external_id)
);
CREATE INDEX IF NOT EXISTS comments_inbox_idx ON comments (client_id, status, remote_created_at DESC);

CREATE TABLE IF NOT EXISTS comment_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id  uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  text        text NOT NULL,
  origin      text NOT NULL CHECK (origin IN ('ai_suggested', 'ai_auto', 'human')),
  status      text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'failed', 'discarded')),
  model       text,
  confidence  real,
  grounding   jsonb NOT NULL DEFAULT '[]',
  external_id text,
  error       text,
  error_kind  text,
  attempts    int NOT NULL DEFAULT 0,
  approved_by text,
  approved_at timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- At most one live reply per comment: a second approval loses instead of double-posting.
CREATE UNIQUE INDEX IF NOT EXISTS comment_replies_one_live_idx ON comment_replies (comment_id)
  WHERE status IN ('approved', 'sending', 'sent');
CREATE INDEX IF NOT EXISTS comment_replies_client_idx ON comment_replies (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- chat_sessions: reply review mode
-- ---------------------------------------------------------------------------
ALTER TABLE chat_sessions ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS reply_id uuid;

ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_reply_id_fkey;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_reply_id_fkey
  FOREIGN KEY (reply_id) REFERENCES comment_replies(id) ON DELETE CASCADE;

ALTER TABLE chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_mode_check;
ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_mode_check
  CHECK (mode IN ('awaiting_edit', 'awaiting_schedule', 'awaiting_reply_edit'));

-- ---------------------------------------------------------------------------
-- automation_policies: auto-reply guard rails (off by default)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automation_policies (
  client_id                 uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  auto_reply_enabled        boolean NOT NULL DEFAULT false,
  channels                  text[] NOT NULL DEFAULT '{}',
  min_confidence            real NOT NULL DEFAULT 0.85,
  escalate_flags            text[] NOT NULL DEFAULT ARRAY[
                              'complaint', 'refund', 'billing', 'legal', 'medical', 'threat',
                              'harassment', 'self_harm', 'personal_data', 'competitor',
                              'pricing_dispute', 'spam', 'off_topic'],
  blocked_keywords          text[] NOT NULL DEFAULT '{}',
  max_auto_replies_per_hour int NOT NULL DEFAULT 20,
  quiet_hours               jsonb,
  reply_to_praise           boolean NOT NULL DEFAULT true,
  require_grounding         boolean NOT NULL DEFAULT true,
  signature                 text NOT NULL DEFAULT '',
  notify_telegram           boolean NOT NULL DEFAULT true,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- knowledge: sources + chunks (FTS now, embeddings in a plain real[])
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('website', 'document', 'faq', 'catalog', 'text')),
  title            text NOT NULL DEFAULT '',
  url              text,
  raw_text         text,
  file_name        text,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'ingesting', 'ready', 'failed')),
  error            text,
  settings         jsonb NOT NULL DEFAULT '{}',
  content_hash     text,
  pages_count      int NOT NULL DEFAULT 0,
  chunks_count     int NOT NULL DEFAULT 0,
  last_ingested_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_client_idx ON knowledge_sources (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id              bigserial PRIMARY KEY,
  source_id       uuid NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  content         text NOT NULL,
  url             text,
  title           text,
  position        int NOT NULL DEFAULT 0,
  embedding       real[],
  -- Embedding spaces are incompatible between models: re-embed when this changes.
  embedding_model text,
  tsv             tsvector GENERATED ALWAYS AS
                    (to_tsvector('simple', coalesce(title, '') || ' ' || content)) STORED,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv_idx ON knowledge_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_client_idx ON knowledge_chunks (client_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_source_idx ON knowledge_chunks (source_id, position);

-- ---------------------------------------------------------------------------
-- webhook_events: store first, process in a job, dedupe on (provider, event_key)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  event_key    text NOT NULL,
  payload      jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts     int NOT NULL DEFAULT 0,
  error        text,
  CONSTRAINT webhook_events_unique UNIQUE (provider, event_key)
);
CREATE INDEX IF NOT EXISTS webhook_events_pending_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- counters
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_counters (
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period    date NOT NULL,
  metric    text NOT NULL,
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, period, metric)
);

-- Project-wide counters with no tenant (shared YouTube quota).
CREATE TABLE IF NOT EXISTS system_counters (
  period date NOT NULL,
  metric text NOT NULL,
  value  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (period, metric)
);

-- ---------------------------------------------------------------------------
-- oauth_states: hashed, single-use, short lived
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash    bytea PRIMARY KEY,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  code_verifier text,
  redirect_path text,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- content_requests: "generate N ideas from my business"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  goal             text NOT NULL DEFAULT '',
  count            int NOT NULL DEFAULT 5,
  channels         text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'done', 'failed')),
  error            text,
  created_post_ids uuid[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_requests_client_idx ON content_requests (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at triggers for every new table that has the column
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS campaigns_updated_at ON campaigns;
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS provider_connections_updated_at ON provider_connections;
CREATE TRIGGER provider_connections_updated_at BEFORE UPDATE ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS social_accounts_updated_at ON social_accounts;
CREATE TRIGGER social_accounts_updated_at BEFORE UPDATE ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS post_targets_updated_at ON post_targets;
CREATE TRIGGER post_targets_updated_at BEFORE UPDATE ON post_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS comments_updated_at ON comments;
CREATE TRIGGER comments_updated_at BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS comment_replies_updated_at ON comment_replies;
CREATE TRIGGER comment_replies_updated_at BEFORE UPDATE ON comment_replies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS automation_policies_updated_at ON automation_policies;
CREATE TRIGGER automation_policies_updated_at BEFORE UPDATE ON automation_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS knowledge_sources_updated_at ON knowledge_sources;
CREATE TRIGGER knowledge_sources_updated_at BEFORE UPDATE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS content_requests_updated_at ON content_requests;
CREATE TRIGGER content_requests_updated_at BEFORE UPDATE ON content_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS chat_sessions_updated_at ON chat_sessions;
CREATE TRIGGER chat_sessions_updated_at BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
