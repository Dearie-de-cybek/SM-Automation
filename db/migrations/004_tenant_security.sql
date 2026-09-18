-- Runtime database boundary. Bootstrap/migration credentials remain one-shot; every
-- long-running process inherits one deliberately narrow NOLOGIN group role.

DO $roles$
DECLARE
  role_name text;
  incompatible boolean;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['sm_app', 'sm_operator', 'sm_worker', 'sm_n8n_core'] LOOP
    SELECT runtime_role.rolcanlogin
           OR runtime_role.rolsuper
           OR runtime_role.rolcreatedb
           OR runtime_role.rolcreaterole
           OR runtime_role.rolreplication
           OR runtime_role.rolbypassrls
           OR EXISTS (
             SELECT 1
               FROM pg_catalog.pg_auth_members inherited_membership
              WHERE inherited_membership.member = runtime_role.oid
           )
      INTO incompatible
      FROM pg_catalog.pg_roles runtime_role
     WHERE runtime_role.rolname = role_name;

    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS',
        role_name
      );
    ELSIF incompatible THEN
      RAISE EXCEPTION 'Refusing incompatible runtime group role %', role_name;
    END IF;
  END LOOP;
END
$roles$;

-- No implicit database access. n8n-core is intentionally absent: it owns only n8n's
-- internal database and uses an imported sm_worker credential for legacy workflows.
DO $database_access$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM sm_n8n_core', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sm_app, sm_operator, sm_worker', current_database());
END
$database_access$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sm_app, sm_operator, sm_worker;

-- Redundant client_id columns must agree with their owning parent. These constraints
-- prevent a tenant-scoped insert from smuggling a reference to another tenant.
DO $tenant_unique_constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'campaigns_id_client_unique' AND conrelid = 'public.campaigns'::regclass) THEN
    ALTER TABLE campaigns ADD CONSTRAINT campaigns_id_client_unique UNIQUE (id, client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'provider_connections_id_client_unique' AND conrelid = 'public.provider_connections'::regclass) THEN
    ALTER TABLE provider_connections ADD CONSTRAINT provider_connections_id_client_unique UNIQUE (id, client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'social_accounts_id_client_unique' AND conrelid = 'public.social_accounts'::regclass) THEN
    ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_id_client_unique UNIQUE (id, client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'posts_id_client_unique' AND conrelid = 'public.posts'::regclass) THEN
    ALTER TABLE posts ADD CONSTRAINT posts_id_client_unique UNIQUE (id, client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'post_targets_id_client_unique' AND conrelid = 'public.post_targets'::regclass) THEN
    ALTER TABLE post_targets ADD CONSTRAINT post_targets_id_client_unique UNIQUE (id, client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'comments_id_client_unique' AND conrelid = 'public.comments'::regclass) THEN
    ALTER TABLE comments ADD CONSTRAINT comments_id_client_unique UNIQUE (id, client_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'knowledge_sources_id_client_unique' AND conrelid = 'public.knowledge_sources'::regclass) THEN
    ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_id_client_unique UNIQUE (id, client_id);
  END IF;
END
$tenant_unique_constraints$;

ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_connection_client_fkey;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_connection_client_fkey
  FOREIGN KEY (connection_id, client_id) REFERENCES provider_connections(id, client_id) ON DELETE CASCADE;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_campaign_client_fkey;
ALTER TABLE posts ADD CONSTRAINT posts_campaign_client_fkey
  FOREIGN KEY (campaign_id, client_id) REFERENCES campaigns(id, client_id) ON DELETE SET NULL (campaign_id);
ALTER TABLE post_targets DROP CONSTRAINT IF EXISTS post_targets_post_client_fkey;
ALTER TABLE post_targets ADD CONSTRAINT post_targets_post_client_fkey
  FOREIGN KEY (post_id, client_id) REFERENCES posts(id, client_id) ON DELETE CASCADE;
ALTER TABLE post_targets DROP CONSTRAINT IF EXISTS post_targets_account_client_fkey;
ALTER TABLE post_targets ADD CONSTRAINT post_targets_account_client_fkey
  FOREIGN KEY (social_account_id, client_id) REFERENCES social_accounts(id, client_id) ON DELETE CASCADE;
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_account_client_fkey;
ALTER TABLE comments ADD CONSTRAINT comments_account_client_fkey
  FOREIGN KEY (social_account_id, client_id) REFERENCES social_accounts(id, client_id) ON DELETE CASCADE;
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_target_client_fkey;
ALTER TABLE comments ADD CONSTRAINT comments_target_client_fkey
  FOREIGN KEY (post_target_id, client_id) REFERENCES post_targets(id, client_id) ON DELETE SET NULL (post_target_id);
ALTER TABLE comment_replies DROP CONSTRAINT IF EXISTS comment_replies_comment_client_fkey;
ALTER TABLE comment_replies ADD CONSTRAINT comment_replies_comment_client_fkey
  FOREIGN KEY (comment_id, client_id) REFERENCES comments(id, client_id) ON DELETE CASCADE;
ALTER TABLE knowledge_chunks DROP CONSTRAINT IF EXISTS knowledge_chunks_source_client_fkey;
ALTER TABLE knowledge_chunks ADD CONSTRAINT knowledge_chunks_source_client_fkey
  FOREIGN KEY (source_id, client_id) REFERENCES knowledge_sources(id, client_id) ON DELETE CASCADE;

UPDATE audit_log audit
   SET client_id = post.client_id
  FROM posts post
 WHERE audit.post_id = post.id
   AND audit.client_id IS DISTINCT FROM post.client_id;
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_post_client_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_post_client_fkey
  FOREIGN KEY (post_id, client_id) REFERENCES posts(id, client_id) ON DELETE SET NULL (post_id);

-- Re-running this file is safe: policies are replaced, never accumulated.
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
ALTER TABLE brand_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
ALTER TABLE post_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE login_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE post_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
ALTER TABLE comment_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_replies FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
ALTER TABLE content_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_requests FORCE ROW LEVEL SECURITY;

-- Direct tenant ownership.
DROP POLICY IF EXISTS clients_app_tenant ON clients;
CREATE POLICY clients_app_tenant ON clients TO sm_app
  USING (id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS brand_profiles_app_tenant ON brand_profiles;
CREATE POLICY brand_profiles_app_tenant ON brand_profiles TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS posts_app_tenant ON posts;
CREATE POLICY posts_app_tenant ON posts TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS audit_log_app_tenant ON audit_log;
CREATE POLICY audit_log_app_tenant ON audit_log TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS campaigns_app_tenant ON campaigns;
CREATE POLICY campaigns_app_tenant ON campaigns TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS provider_connections_app_tenant ON provider_connections;
CREATE POLICY provider_connections_app_tenant ON provider_connections TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS social_accounts_app_tenant ON social_accounts;
CREATE POLICY social_accounts_app_tenant ON social_accounts TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS post_targets_app_tenant ON post_targets;
CREATE POLICY post_targets_app_tenant ON post_targets TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS comments_app_tenant ON comments;
CREATE POLICY comments_app_tenant ON comments TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS comment_replies_app_tenant ON comment_replies;
CREATE POLICY comment_replies_app_tenant ON comment_replies TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS automation_policies_app_tenant ON automation_policies;
CREATE POLICY automation_policies_app_tenant ON automation_policies TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS knowledge_sources_app_tenant ON knowledge_sources;
CREATE POLICY knowledge_sources_app_tenant ON knowledge_sources TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS knowledge_chunks_app_tenant ON knowledge_chunks;
CREATE POLICY knowledge_chunks_app_tenant ON knowledge_chunks TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS usage_counters_app_tenant ON usage_counters;
CREATE POLICY usage_counters_app_tenant ON usage_counters TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS oauth_states_app_tenant ON oauth_states;
CREATE POLICY oauth_states_app_tenant ON oauth_states TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);
DROP POLICY IF EXISTS content_requests_app_tenant ON content_requests;
CREATE POLICY content_requests_app_tenant ON content_requests TO sm_app
  USING (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid)
  WITH CHECK (client_id = NULLIF(current_setting('app.client_id', true), '')::uuid);

-- Indirect ownership follows a parent that is itself tenant scoped.
DROP POLICY IF EXISTS post_versions_app_tenant ON post_versions;
CREATE POLICY post_versions_app_tenant ON post_versions TO sm_app
  USING (EXISTS (
    SELECT 1 FROM public.posts tenant_post
     WHERE tenant_post.id = post_versions.post_id
       AND tenant_post.client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.posts tenant_post
     WHERE tenant_post.id = post_versions.post_id
       AND tenant_post.client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
  ));
DROP POLICY IF EXISTS chat_sessions_app_tenant ON chat_sessions;
CREATE POLICY chat_sessions_app_tenant ON chat_sessions TO sm_app
  USING (
    EXISTS (
      SELECT 1 FROM public.posts tenant_post
       WHERE tenant_post.id = chat_sessions.post_id
         AND tenant_post.client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
    ) OR EXISTS (
      SELECT 1 FROM public.comment_replies tenant_reply
       WHERE tenant_reply.id = chat_sessions.reply_id
         AND tenant_reply.client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.posts tenant_post
       WHERE tenant_post.id = chat_sessions.post_id
         AND tenant_post.client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
    ) OR EXISTS (
      SELECT 1 FROM public.comment_replies tenant_reply
       WHERE tenant_reply.id = chat_sessions.reply_id
         AND tenant_reply.client_id = NULLIF(current_setting('app.client_id', true), '')::uuid
    )
  );

-- Trusted worker is intentionally cross-tenant. Separate policies make this power
-- visible and auditable instead of relying on BYPASSRLS (which remains false).
DROP POLICY IF EXISTS clients_worker_all ON clients;
CREATE POLICY clients_worker_all ON clients TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS brand_profiles_worker_all ON brand_profiles;
CREATE POLICY brand_profiles_worker_all ON brand_profiles TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS posts_worker_all ON posts;
CREATE POLICY posts_worker_all ON posts TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS post_versions_worker_all ON post_versions;
CREATE POLICY post_versions_worker_all ON post_versions TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS chat_sessions_worker_all ON chat_sessions;
CREATE POLICY chat_sessions_worker_all ON chat_sessions TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS audit_log_worker_all ON audit_log;
CREATE POLICY audit_log_worker_all ON audit_log TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS login_tokens_worker_all ON login_tokens;
CREATE POLICY login_tokens_worker_all ON login_tokens TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS campaigns_worker_all ON campaigns;
CREATE POLICY campaigns_worker_all ON campaigns TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS provider_connections_worker_all ON provider_connections;
CREATE POLICY provider_connections_worker_all ON provider_connections TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS social_accounts_worker_all ON social_accounts;
CREATE POLICY social_accounts_worker_all ON social_accounts TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS post_targets_worker_all ON post_targets;
CREATE POLICY post_targets_worker_all ON post_targets TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS comments_worker_all ON comments;
CREATE POLICY comments_worker_all ON comments TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS comment_replies_worker_all ON comment_replies;
CREATE POLICY comment_replies_worker_all ON comment_replies TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS automation_policies_worker_all ON automation_policies;
CREATE POLICY automation_policies_worker_all ON automation_policies TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS knowledge_sources_worker_all ON knowledge_sources;
CREATE POLICY knowledge_sources_worker_all ON knowledge_sources TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS knowledge_chunks_worker_all ON knowledge_chunks;
CREATE POLICY knowledge_chunks_worker_all ON knowledge_chunks TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS usage_counters_worker_all ON usage_counters;
CREATE POLICY usage_counters_worker_all ON usage_counters TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS oauth_states_worker_all ON oauth_states;
CREATE POLICY oauth_states_worker_all ON oauth_states TO sm_worker USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS content_requests_worker_all ON content_requests;
CREATE POLICY content_requests_worker_all ON content_requests TO sm_worker USING (true) WITH CHECK (true);

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM sm_app, sm_operator, sm_worker, sm_n8n_core;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM sm_app, sm_operator, sm_worker, sm_n8n_core;

-- Tenant dashboard privileges. login_tokens/chat_sessions and global service tables are
-- intentionally absent; pre-authentication is available only through functions below.
GRANT SELECT (
  id, name, telegram_chat_id, telegram_link_code, fb_page_id, fb_page_name, ig_user_id,
  ig_username, meta_connected_at, timezone, default_platforms, active, plan,
  plan_overrides, created_at, updated_at
) ON clients TO sm_app;
GRANT UPDATE (
  timezone, fb_page_id, fb_page_name, ig_user_id, ig_username, meta_token_enc,
  meta_connected_at, default_platforms, updated_at
) ON clients TO sm_app;
GRANT SELECT, INSERT, UPDATE ON brand_profiles TO sm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns, posts, post_targets, comments,
  comment_replies, automation_policies, knowledge_sources, provider_connections,
  social_accounts, oauth_states, content_requests TO sm_app;
GRANT SELECT, INSERT ON post_versions, audit_log TO sm_app;
GRANT SELECT ON knowledge_chunks, usage_counters TO sm_app;
GRANT USAGE, SELECT ON SEQUENCE post_versions_id_seq, audit_log_id_seq TO sm_app;

-- Worker owns every state transition, sweep, webhook and legacy workflow query.
GRANT SELECT, INSERT, UPDATE, DELETE ON clients, brand_profiles, posts, post_versions,
  chat_sessions, audit_log, login_tokens, campaigns, provider_connections,
  social_accounts, post_targets, comments, comment_replies, automation_policies,
  knowledge_sources, knowledge_chunks, usage_counters, oauth_states, content_requests,
  webhook_events, system_counters, data_deletion_requests TO sm_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sm_worker;

CREATE OR REPLACE FUNCTION app_store_webhook_event(
  p_provider text, p_event_key text, p_payload jsonb
)
RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO public.webhook_events (provider, event_key, payload)
  VALUES (p_provider, p_event_key, p_payload)
  ON CONFLICT (provider, event_key) DO NOTHING
  RETURNING id
$function$;

CREATE OR REPLACE FUNCTION app_create_client(p_name text, p_timezone text, p_link_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  created_id uuid;
BEGIN
  IF char_length(btrim(p_name)) NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'Client name must contain 2 to 100 characters';
  END IF;
  IF p_link_code !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'Invalid Telegram link code';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone) THEN
    RAISE EXCEPTION 'Unknown timezone';
  END IF;
  INSERT INTO public.clients (name, timezone, telegram_link_code)
  VALUES (btrim(p_name), p_timezone, p_link_code)
  RETURNING id INTO created_id;
  INSERT INTO public.brand_profiles (client_id) VALUES (created_id);
  RETURN created_id;
END
$function$;

CREATE OR REPLACE FUNCTION app_signup_client(p_link_code text)
RETURNS TABLE(name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT client.name
    FROM public.clients client
   WHERE p_link_code ~ '^[0-9a-f]{32}$'
     AND client.telegram_link_code = p_link_code
     AND client.active
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION app_consume_login_token(p_token text)
RETURNS TABLE(client_id uuid, chat_id text, is_admin boolean, client_active boolean)
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH used AS (
    UPDATE public.login_tokens token
       SET used_at = now()
     WHERE p_token ~ '^[0-9a-f]{48}$'
       AND token.token_hash = public.digest(p_token, 'sha256')
       AND token.used_at IS NULL
       AND token.expires_at > now()
    RETURNING token.client_id, token.chat_id, token.is_admin
  )
  SELECT used.client_id, used.chat_id::text, used.is_admin, client.active
    FROM used
    LEFT JOIN public.clients client ON client.id = used.client_id
$function$;

CREATE OR REPLACE FUNCTION app_admin_create_client(p_name text, p_link_code text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.app_create_client(p_name, 'UTC', p_link_code)
$function$;

CREATE OR REPLACE FUNCTION app_admin_list_clients()
RETURNS TABLE(
  id uuid, name text, telegram_chat_id text, telegram_link_code text,
  fb_page_id text, fb_page_name text, ig_user_id text, ig_username text,
  meta_connected boolean, meta_connected_at timestamptz, timezone text,
  active boolean, created_at timestamptz, posts_total integer,
  posts_awaiting integer, posts_published integer, last_post_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT client.id, client.name, client.telegram_chat_id::text,
         client.telegram_link_code, client.fb_page_id, client.fb_page_name,
         client.ig_user_id, client.ig_username,
         client.meta_connected_at IS NOT NULL, client.meta_connected_at,
         client.timezone, client.active, client.created_at,
         count(post.id)::integer,
         count(post.id) FILTER (WHERE post.status = 'pending_approval')::integer,
         count(post.id) FILTER (WHERE post.status IN ('published', 'partially_published'))::integer,
         max(post.created_at)
    FROM public.clients client
    LEFT JOIN public.posts post ON post.client_id = client.id
   GROUP BY client.id
   ORDER BY client.created_at DESC
$function$;

CREATE OR REPLACE FUNCTION app_admin_toggle_client(p_client_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  UPDATE public.clients SET active = NOT active
   WHERE id = p_client_id
  RETURNING active
$function$;

CREATE OR REPLACE FUNCTION app_meta_deauthorize(p_external_user_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE changed integer;
BEGIN
  UPDATE public.provider_connections
     SET status = 'revoked', credentials_enc = NULL,
         last_error = 'The Facebook account that connected this was removed from the app.',
         updated_at = now()
   WHERE provider = 'meta' AND meta ->> 'userId' = p_external_user_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  UPDATE public.social_accounts
     SET status = 'revoked', credentials_enc = NULL, updated_at = now()
   WHERE provider = 'meta'
     AND connection_id IN (
       SELECT id FROM public.provider_connections
        WHERE provider = 'meta' AND meta ->> 'userId' = p_external_user_id
     );
  RETURN changed;
END
$function$;

CREATE OR REPLACE FUNCTION app_meta_delete_user(p_external_user_id text, p_code text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE deleted_count integer;
BEGIN
  DELETE FROM public.provider_connections
   WHERE provider = 'meta' AND meta ->> 'userId' = p_external_user_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  INSERT INTO public.data_deletion_requests
    (code, provider, external_user_id, status, detail, completed_at)
  VALUES (
    p_code, 'meta', p_external_user_id,
    CASE WHEN deleted_count > 0 THEN 'completed' ELSE 'not_found' END,
    jsonb_build_object('connectionsDeleted', deleted_count), now()
  );
  RETURN deleted_count;
END
$function$;

CREATE OR REPLACE FUNCTION app_data_deletion_status(p_code text)
RETURNS TABLE(code text, status text, requested_at timestamptz, completed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT request.code, request.status, request.requested_at, request.completed_at
    FROM public.data_deletion_requests request
   WHERE request.code = p_code
   LIMIT 1
$function$;

REVOKE ALL ON FUNCTION app_create_client(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_store_webhook_event(text, text, jsonb)
  FROM PUBLIC, sm_operator, sm_worker, sm_n8n_core;
REVOKE ALL ON FUNCTION app_signup_client(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_consume_login_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_admin_create_client(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_admin_list_clients() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_admin_toggle_client(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_meta_deauthorize(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_meta_delete_user(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_data_deletion_status(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION app_admin_create_client(text, text) FROM sm_app;
REVOKE ALL ON FUNCTION app_admin_list_clients() FROM sm_app;
REVOKE ALL ON FUNCTION app_admin_toggle_client(uuid) FROM sm_app;
REVOKE ALL ON FUNCTION app_meta_deauthorize(text) FROM sm_app;
REVOKE ALL ON FUNCTION app_meta_delete_user(text, text) FROM sm_app;

GRANT EXECUTE ON FUNCTION app_create_client(text, text, text) TO sm_app;
GRANT EXECUTE ON FUNCTION app_store_webhook_event(text, text, jsonb) TO sm_app;
GRANT EXECUTE ON FUNCTION app_signup_client(text) TO sm_app;
GRANT EXECUTE ON FUNCTION app_consume_login_token(text) TO sm_app;
GRANT EXECUTE ON FUNCTION app_data_deletion_status(text) TO sm_app;
GRANT EXECUTE ON FUNCTION app_admin_create_client(text, text) TO sm_operator;
GRANT EXECUTE ON FUNCTION app_admin_list_clients() TO sm_operator;
GRANT EXECUTE ON FUNCTION app_admin_toggle_client(uuid) TO sm_operator;
GRANT EXECUTE ON FUNCTION app_meta_deauthorize(text) TO sm_operator;
GRANT EXECUTE ON FUNCTION app_meta_delete_user(text, text) TO sm_operator;
