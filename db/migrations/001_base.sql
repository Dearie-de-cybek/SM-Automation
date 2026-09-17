-- App schema for the social post assistant (database: smapp).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One row per business using the bot.
CREATE TABLE IF NOT EXISTS clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  -- Set when the client opens t.me/<bot>?start=link_<telegram_link_code>.
  telegram_chat_id   bigint UNIQUE,
  telegram_link_code text UNIQUE,
  fb_page_id         text,
  fb_page_name       text,
  ig_user_id         text,
  ig_username        text,
  -- Page access token, encrypted with pgp_sym_encrypt(token, TOKEN_ENCRYPTION_KEY).
  meta_token_enc     bytea,
  meta_connected_at  timestamptz,
  timezone           text NOT NULL DEFAULT 'UTC',
  default_platforms text[] NOT NULL DEFAULT ARRAY['facebook', 'instagram'],
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clients_platforms_valid CHECK (default_platforms <@ ARRAY['facebook', 'instagram'])
);

CREATE TABLE IF NOT EXISTS brand_profiles (
  client_id            uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  business_description text NOT NULL DEFAULT '',
  voice                text NOT NULL DEFAULT 'Friendly, clear and professional',
  audience             text NOT NULL DEFAULT '',
  language             text NOT NULL DEFAULT 'English',
  default_cta          text NOT NULL DEFAULT '',
  hashtags             text[] NOT NULL DEFAULT '{}',
  banned_words         text[] NOT NULL DEFAULT '{}',
  emoji_policy         text NOT NULL DEFAULT 'A few relevant emojis',
  sample_posts         text NOT NULL DEFAULT '',
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Post lifecycle:
-- generating → pending_approval → (approved | scheduled) → publishing → published | partially_published | failed
-- generating → draft_failed;  pending_approval | scheduled → rejected
CREATE TABLE IF NOT EXISTS posts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  brief            text NOT NULL DEFAULT '',
  source_media_url text,
  platforms        text[] NOT NULL,
  status           text NOT NULL DEFAULT 'generating' CHECK (status IN (
                     'generating', 'draft_failed', 'pending_approval', 'approved', 'scheduled',
                     'publishing', 'published', 'partially_published', 'failed', 'rejected')),
  current_version  int NOT NULL DEFAULT 0,
  publish_at       timestamptz,
  approved_at      timestamptz,
  published_at     timestamptz,
  fb_post_id       text,
  fb_permalink     text,
  ig_container_id  text,
  ig_media_id      text,
  ig_permalink     text,
  error            text,
  attempts         int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_due_idx ON posts (publish_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS posts_in_flight_idx ON posts (updated_at) WHERE status IN ('generating', 'publishing');
CREATE INDEX IF NOT EXISTS posts_client_idx ON posts (client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS post_versions (
  id         bigserial PRIMARY KEY,
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  version    int NOT NULL,
  fb_caption text NOT NULL DEFAULT '',
  ig_caption text NOT NULL DEFAULT '',
  feedback   text,
  model      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, version)
);

-- What the bot is waiting for in a chat (an edit instruction or a schedule time).
CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_id    bigint PRIMARY KEY,
  mode       text NOT NULL CHECK (mode IN ('awaiting_edit', 'awaiting_schedule')),
  post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Who approved/rejected what, and every publish outcome.
CREATE TABLE IF NOT EXISTS audit_log (
  id            bigserial PRIMARY KEY,
  client_id     uuid REFERENCES clients(id) ON DELETE SET NULL,
  post_id       uuid REFERENCES posts(id) ON DELETE SET NULL,
  actor_chat_id bigint,
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_post_idx ON audit_log (post_id, created_at);

-- One-time dashboard login links sent by the bot. Only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash bytea PRIMARY KEY,
  client_id  uuid REFERENCES clients(id) ON DELETE CASCADE,
  chat_id    bigint NOT NULL,
  is_admin   boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS clients_updated_at ON clients;
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS brand_profiles_updated_at ON brand_profiles;
CREATE TRIGGER brand_profiles_updated_at BEFORE UPDATE ON brand_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS posts_updated_at ON posts;
CREATE TRIGGER posts_updated_at BEFORE UPDATE ON posts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

