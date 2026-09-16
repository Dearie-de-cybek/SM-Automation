-- Create or update a client and its brand profile. Called by scripts/add-client.sh.
\set ON_ERROR_STOP on

-- Fails early on an invalid IANA timezone name.
SELECT now() AT TIME ZONE :'timezone' AS client_local_time;

BEGIN;

INSERT INTO clients (name, telegram_chat_id, fb_page_id, ig_user_id, meta_token_enc, timezone, default_platforms)
VALUES (
  :'name',
  :'chat_id',
  NULLIF(:'fb_page_id', ''),
  NULLIF(:'ig_user_id', ''),
  CASE WHEN :'page_token' = '' THEN NULL ELSE pgp_sym_encrypt(:'page_token', :'enc_key') END,
  :'timezone',
  CASE WHEN NULLIF(:'ig_user_id', '') IS NULL THEN ARRAY['facebook'] ELSE ARRAY['facebook', 'instagram'] END
)
ON CONFLICT (telegram_chat_id) DO UPDATE SET
  name = EXCLUDED.name,
  fb_page_id = EXCLUDED.fb_page_id,
  ig_user_id = EXCLUDED.ig_user_id,
  meta_token_enc = COALESCE(EXCLUDED.meta_token_enc, clients.meta_token_enc),
  timezone = EXCLUDED.timezone,
  default_platforms = EXCLUDED.default_platforms,
  active = true
RETURNING id AS client_id \gset

INSERT INTO brand_profiles (client_id, business_description, voice, audience, language, default_cta, hashtags, banned_words)
VALUES (
  :'client_id',
  :'business',
  COALESCE(NULLIF(:'voice', ''), 'Friendly, clear and professional'),
  :'audience',
  COALESCE(NULLIF(:'language', ''), 'English'),
  :'cta',
  ARRAY(SELECT btrim(x) FROM unnest(string_to_array(:'hashtags', ',')) AS x WHERE btrim(x) <> ''),
  ARRAY(SELECT btrim(x) FROM unnest(string_to_array(:'banned', ',')) AS x WHERE btrim(x) <> '')
)
ON CONFLICT (client_id) DO UPDATE SET
  business_description = EXCLUDED.business_description,
  voice = EXCLUDED.voice,
  audience = EXCLUDED.audience,
  language = EXCLUDED.language,
  default_cta = EXCLUDED.default_cta,
  hashtags = EXCLUDED.hashtags,
  banned_words = EXCLUDED.banned_words;

COMMIT;

\echo Client saved with id :client_id
