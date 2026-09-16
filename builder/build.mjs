// Generates n8n workflow JSON into ../workflows. Run: node builder/build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Workflow, WORKFLOW_IDS as ID, CREDENTIALS, validate,
  code, pg, tg, graph, httpJson, ifTrue, switchIndex, executeWorkflow, subworkflowTrigger,
  telegramTrigger, telegramDownload, s3Upload, waitSeconds, scheduleEveryMinutes, errorTrigger,
} from './lib.mjs';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows');

const settings = (extra = {}) => ({
  executionOrder: 'v1',
  errorWorkflow: ID.errors,
  callerPolicy: 'workflowsFromSameOwner',
  ...extra,
});
const CONTINUE = { onError: 'continueRegularOutput' };
const BRANCH_ON_ERROR = { onError: 'continueErrorOutput' };

// ============================================================================
// 1. Telegram Router: every message and button press enters here.
// ============================================================================
function buildRouter() {
  const w = new Workflow({ id: ID.router, name: 'SM · Telegram Router', settings: settings() });
  const C = "$('Build Context').first().json";

  w.add(telegramTrigger('Telegram Trigger', [0, 8], ID.router));
  w.add(code('Normalize Update', [1, 8], 'router/normalize-update.js'));
  // Always returns one row; client columns are NULL for unknown chats.
  w.add(pg('Load Client', [2, 8], `
SELECT c.id AS client_id, c.name AS client_name, c.timezone,
       s.mode AS session_mode, s.post_id AS session_post_id,
       ($1::text = NULLIF($2::text, '')) AS is_admin
FROM (SELECT 1) AS one
LEFT JOIN clients c ON c.telegram_chat_id = $1::bigint AND c.active
LEFT JOIN chat_sessions s ON s.chat_id = c.telegram_chat_id;`,
  "[ $json.chat_id, $env.ADMIN_TELEGRAM_CHAT_ID || '' ]", { alwaysOutputData: true }));
  w.add(code('Build Context', [3, 8], 'router/build-context.js'));
  w.add(switchIndex('Route', [4, 8], 9, '$json.route_index'));
  w.chain('Telegram Trigger', 'Normalize Update', 'Load Client', 'Build Context', 'Route');

  const DASHBOARD = "($env.DASHBOARD_URL || '').replace(/\\/+$/, '')";

  // 0 · unknown chat
  w.add(tg('Reply Unauthorized', [5, 0], 'sendMessage',
    `{ chat_id: ${C}.chat_id, text: "This chat isn't connected to an account yet.\\n\\nCreate your account here, then tap the Telegram button it shows you:\\n" + ${DASHBOARD} + "/signup\\n\\n(Chat ID: " + ${C}.chat_id + ")" }`));
  w.link('Route', 'Reply Unauthorized', 0);

  // 1 · help
  w.add(tg('Reply Help', [5, 1], 'sendMessage', `{ chat_id: ${C}.chat_id, text: [
    '👋 I draft your Facebook and Instagram posts. Nothing goes live until you approve it.',
    'HOW TO START\\n• Send a photo (as a photo, not a file) with a caption describing the post\\n• Or send a text brief for a Facebook-only post',
    'EXAMPLES\\n• [photo] Weekend promo: 20% off all pastries until Sunday\\n• Announce new opening hours, Mon-Sat 8am-8pm',
    'Then use the buttons under the draft: 🚀 publish, 🕒 schedule, ✏️ edit, 🔁 regenerate or ❌ discard.',
    'COMMANDS\\n/new <brief> - start a post\\n/dashboard - get a login link to see all your posts\\n/cancel - stop editing or scheduling'
  ].join('\\n\\n') }`));
  w.link('Route', 'Reply Help', 1);

  // 2 · new post
  w.add(ifTrue('Has Photo?', [5, 3], '!!$json.photo_file_id'));
  w.add(code('Media Key', [6, 2], 'router/media-key.js'));
  w.add(telegramDownload('Download Photo', [7, 2], "$('Media Key').first().json.photo_file_id"));
  w.add(s3Upload('Upload Photo', [8, 2], { bucketExpr: '$env.S3_BUCKET', keyExpr: "$('Media Key').first().json.media_key" }));
  w.add(code('Media Ready', [9, 2], "return [{ json: $('Media Key').first().json }];"));
  w.add(pg('Create Post', [10, 3], `
WITH c AS (
  SELECT id, default_platforms FROM clients WHERE id = $1::uuid
), s AS (
  DELETE FROM chat_sessions WHERE chat_id = $4::bigint
)
INSERT INTO posts (client_id, brief, source_media_url, platforms, status)
SELECT c.id, $2, NULLIF($3, ''),
       CASE WHEN NULLIF($3, '') IS NULL THEN array_remove(c.default_platforms, 'instagram') ELSE c.default_platforms END,
       'generating'
FROM c
RETURNING id AS post_id;`,
  "[ $json.client_id, $json.text, $json.media_key ? $env.MEDIA_PUBLIC_BASE_URL.replace(/\\/+$/, '') + '/' + $json.media_key : '', $json.chat_id ]"));
  w.add(tg('Ack Drafting', [11, 2], 'sendMessage', `{ chat_id: ${C}.chat_id, text: "✍️ Drafting your post. I'll send it here for approval in a moment." }`));
  w.add(executeWorkflow('Generate Draft', [12, 4], ID.generate));
  w.link('Route', 'Has Photo?', 2);
  w.link('Has Photo?', 'Media Key', 0);
  w.link('Has Photo?', 'Create Post', 1);
  w.chain('Media Key', 'Download Photo', 'Upload Photo', 'Media Ready', 'Create Post');
  w.link('Create Post', 'Ack Drafting');
  w.link('Create Post', 'Generate Draft');

  // 3 · button pressed
  w.add(tg('Answer Callback', [5, 8], 'answerCallbackQuery', `{ callback_query_id: ${C}.callback_id }`, CONTINUE));
  w.add(code('Parse Callback', [6, 8], 'router/parse-callback.js'));
  w.add(pg('Load Post For Action', [7, 8],
    'SELECT id AS post_id, status FROM posts WHERE id = $1::uuid AND client_id = $2::uuid;',
    '[ $json.post_id, $json.client_id ]', { alwaysOutputData: true }));
  w.add(code('Decide Action', [8, 8], 'router/decide-action.js'));
  w.add(switchIndex('Action', [9, 8], 7, '$json.action_index'));
  w.link('Route', 'Answer Callback', 3);
  w.chain('Answer Callback', 'Parse Callback', 'Load Post For Action', 'Decide Action', 'Action');

  const actionParams = '[ $json.post_id, $json.client_id, $json.chat_id ]';

  w.add(pg('Approve Now', [10, 5], `
WITH s AS (
  DELETE FROM chat_sessions WHERE post_id = $1::uuid
), upd AS (
  UPDATE posts SET status = 'approved', approved_at = now(), publish_at = NULL
  WHERE id = $1::uuid AND client_id = $2::uuid AND status IN ('pending_approval', 'scheduled')
  RETURNING id, client_id
), audit AS (
  INSERT INTO audit_log (client_id, post_id, actor_chat_id, action)
  SELECT client_id, id, $3::bigint, 'approved_publish_now' FROM upd
)
SELECT id AS post_id FROM upd;`, actionParams));
  w.add(tg('Ack Publishing', [11, 5], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '🚀 Publishing now…' }`));
  w.add(executeWorkflow('Publish Post', [12, 6], ID.publish));
  w.link('Action', 'Approve Now', 0);
  w.link('Approve Now', 'Ack Publishing');
  w.link('Approve Now', 'Publish Post');

  w.add(pg('Await Schedule Time', [10, 7], `
INSERT INTO chat_sessions (chat_id, mode, post_id)
VALUES ($3::bigint, 'awaiting_schedule', $1::uuid)
ON CONFLICT (chat_id) DO UPDATE SET mode = EXCLUDED.mode, post_id = EXCLUDED.post_id, updated_at = now()
RETURNING chat_id;`, actionParams));
  w.add(tg('Ask Schedule Time', [11, 7], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '🕒 When should it go out? Reply with a time, for example:\\n• 18:30 (today, or tomorrow if that has passed)\\n• tomorrow 9am\\n• 2026-12-24 18:00\\n• +2h\\n\\nTimezone: ' + ${C}.timezone + '\\n/cancel to stop.' }`));
  w.link('Action', 'Await Schedule Time', 1);
  w.link('Await Schedule Time', 'Ask Schedule Time');

  w.add(pg('Await Edit', [10, 9], `
INSERT INTO chat_sessions (chat_id, mode, post_id)
VALUES ($3::bigint, 'awaiting_edit', $1::uuid)
ON CONFLICT (chat_id) DO UPDATE SET mode = EXCLUDED.mode, post_id = EXCLUDED.post_id, updated_at = now()
RETURNING chat_id;`, actionParams));
  w.add(tg('Ask For Changes', [11, 9], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '✏️ What should I change? Reply in your own words, e.g. "shorter, mention free delivery, fewer emojis".\\n/cancel to stop.' }`));
  w.link('Action', 'Await Edit', 2);
  w.link('Await Edit', 'Ask For Changes');

  w.add(pg('Start Regenerate', [10, 11], `
WITH s AS (
  DELETE FROM chat_sessions WHERE post_id = $1::uuid
)
UPDATE posts SET status = 'generating'
WHERE id = $1::uuid AND client_id = $2::uuid AND status = 'pending_approval'
RETURNING id AS post_id,
  'Write a fresh alternative with a different hook and angle. Do not reuse the previous wording.'::text AS feedback;`, actionParams));
  w.add(tg('Ack Regenerate', [11, 11], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '🔁 Writing a fresh version…' }`));
  w.link('Action', 'Start Regenerate', 3);
  w.link('Start Regenerate', 'Ack Regenerate');
  w.link('Start Regenerate', 'Generate Draft');

  w.add(pg('Reject Post', [10, 13], `
WITH s AS (
  DELETE FROM chat_sessions WHERE post_id = $1::uuid
), upd AS (
  UPDATE posts SET status = 'rejected', publish_at = NULL
  WHERE id = $1::uuid AND client_id = $2::uuid AND status IN ('pending_approval', 'scheduled')
  RETURNING id, client_id
), audit AS (
  INSERT INTO audit_log (client_id, post_id, actor_chat_id, action)
  SELECT client_id, id, $3::bigint, 'rejected' FROM upd
)
SELECT id AS post_id FROM upd;`, actionParams));
  w.add(tg('Ack Rejected', [11, 13], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '🗑 Draft discarded.' }`));
  w.link('Action', 'Reject Post', 4);
  w.link('Reject Post', 'Ack Rejected');

  w.add(pg('Retry Publish', [10, 15], `
WITH upd AS (
  UPDATE posts SET status = 'approved', error = NULL
  WHERE id = $1::uuid AND client_id = $2::uuid AND status IN ('failed', 'partially_published')
  RETURNING id, client_id
), audit AS (
  INSERT INTO audit_log (client_id, post_id, actor_chat_id, action)
  SELECT client_id, id, $3::bigint, 'retry_publish' FROM upd
)
SELECT id AS post_id FROM upd;`, actionParams));
  w.add(tg('Ack Retry', [11, 15], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '🔁 Retrying…' }`));
  w.link('Action', 'Retry Publish', 5);
  w.link('Retry Publish', 'Ack Retry');
  w.link('Retry Publish', 'Publish Post');

  w.add(tg('Reply Stale', [10, 17], 'sendMessage',
    `{ chat_id: ${C}.chat_id, text: 'That button is no longer active (post is ' + String($json.post_status).replace(/_/g, ' ') + ').' }`));
  w.link('Action', 'Reply Stale', 6);

  // Remove the inline keyboard once a final decision is made, so it can't be tapped twice.
  w.add(tg('Remove Buttons', [12, 12], 'editMessageReplyMarkup',
    `{ chat_id: ${C}.chat_id, message_id: ${C}.message_id, reply_markup: { inline_keyboard: [] } }`, CONTINUE));
  for (const from of ['Approve Now', 'Start Regenerate', 'Reject Post', 'Retry Publish']) w.link(from, 'Remove Buttons');

  // 4 · reply to "what should I change?"
  w.add(pg('Start Revision', [5, 19], `
WITH cleared AS (
  DELETE FROM chat_sessions WHERE chat_id = $1::bigint RETURNING post_id
)
UPDATE posts p SET status = 'generating'
FROM cleared
WHERE p.id = cleared.post_id AND p.status = 'pending_approval'
RETURNING p.id AS post_id, $2::text AS feedback;`, '[ $json.chat_id, $json.text ]'));
  w.add(tg('Ack Revision', [6, 19], 'sendMessage', `{ chat_id: ${C}.chat_id, text: '✏️ Revising the draft…' }`));
  w.link('Route', 'Start Revision', 4);
  w.link('Start Revision', 'Ack Revision');
  w.link('Start Revision', 'Generate Draft');

  // 5 · reply to "when should it go out?"
  w.add(code('Parse Schedule Time', [5, 21], 'router/parse-schedule-time.js'));
  w.add(ifTrue('Time Valid?', [6, 21], '$json.ok'));
  w.add(pg('Schedule Post', [7, 20], `
WITH cleared AS (
  DELETE FROM chat_sessions WHERE chat_id = $1::bigint RETURNING post_id
), upd AS (
  UPDATE posts p SET status = 'scheduled', publish_at = $2::timestamptz, approved_at = now()
  FROM cleared
  WHERE p.id = cleared.post_id AND p.status IN ('pending_approval', 'scheduled')
  RETURNING p.id, p.client_id
), audit AS (
  INSERT INTO audit_log (client_id, post_id, actor_chat_id, action, detail)
  SELECT client_id, id, $1::bigint, 'approved_scheduled', jsonb_build_object('publish_at', $2::text) FROM upd
)
SELECT id AS post_id FROM upd;`, '[ $json.chat_id, $json.publish_at ]'));
  w.add(tg('Confirm Schedule', [8, 20], 'sendMessage',
    `{ chat_id: ${C}.chat_id, text: '✅ Scheduled for ' + $('Parse Schedule Time').first().json.local_label + '.\\n\\nTap 🚀 Publish now on the draft to post sooner, or ❌ Discard to cancel it.' }`));
  w.add(tg('Reply Bad Time', [7, 22], 'sendMessage',
    `{ chat_id: ${C}.chat_id, text: "I couldn't use that time: " + $json.reason + '.\\n\\nTry 18:30, tomorrow 9am, 2026-12-24 18:00 or +2h.\\n/cancel to stop.' }`));
  w.link('Route', 'Parse Schedule Time', 5);
  w.link('Parse Schedule Time', 'Time Valid?');
  w.link('Time Valid?', 'Schedule Post', 0);
  w.link('Time Valid?', 'Reply Bad Time', 1);
  w.link('Schedule Post', 'Confirm Schedule');

  // 6 · /cancel
  w.add(pg('Clear Session', [5, 24], 'DELETE FROM chat_sessions WHERE chat_id = $1::bigint;', '[ $json.chat_id ]', { alwaysOutputData: true }));
  w.add(tg('Reply Cancelled', [6, 24], 'sendMessage', `{ chat_id: ${C}.chat_id, text: "Okay, cancelled. The buttons on your last draft still work." }`));
  w.link('Route', 'Clear Session', 6);
  w.link('Clear Session', 'Reply Cancelled');

  // 7 · /start link_<code> from the dashboard signup page: attach this chat to the new account.
  // A login token is minted in the same statement so the reply can open the dashboard directly.
  w.add(pg('Link Chat', [5, 26], `
WITH linked AS (
  UPDATE clients SET telegram_chat_id = $1::bigint, telegram_link_code = NULL
  WHERE telegram_link_code = $2
    AND NOT EXISTS (SELECT 1 FROM clients WHERE telegram_chat_id = $1::bigint)
  RETURNING id, name
), tok AS (
  SELECT encode(gen_random_bytes(24), 'hex') AS token
), ins AS (
  INSERT INTO login_tokens (token_hash, client_id, chat_id, expires_at)
  SELECT digest(tok.token, 'sha256'), linked.id, $1::bigint, now() + interval '15 minutes'
  FROM linked CROSS JOIN tok
)
SELECT linked.name AS client_name, tok.token FROM linked CROSS JOIN tok;`,
  "[ $json.chat_id, $json.link_code || '' ]", { alwaysOutputData: true }));
  w.add(ifTrue('Linked?', [6, 26], '!!$json.token'));
  w.add(tg('Reply Linked', [7, 25], 'sendMessage', `{
    chat_id: ${C}.chat_id,
    text: '✅ This chat is now connected to ' + $json.client_name + '.\\n\\nNext, open your dashboard to connect your Facebook Page and fill in your brand profile. After that, just send me a photo with a short brief whenever you want a post.',
    reply_markup: { inline_keyboard: [[{ text: '📊 Open dashboard', url: ${DASHBOARD} + '/auth/telegram?token=' + $json.token }]] }
  }`));
  w.add(tg('Reply Link Invalid', [7, 27], 'sendMessage',
    `{ chat_id: ${C}.chat_id, text: 'That link is invalid or was already used, or this chat is already connected. Send /dashboard to log in.' }`));
  w.link('Route', 'Link Chat', 7);
  w.link('Link Chat', 'Linked?');
  w.link('Linked?', 'Reply Linked', 0);
  w.link('Linked?', 'Reply Link Invalid', 1);

  // 8 · /dashboard: one-time login link (URL button, so Telegram never pre-fetches it).
  w.add(pg('Create Login Token', [5, 29], `
WITH tok AS (
  SELECT encode(gen_random_bytes(24), 'hex') AS token
), ins AS (
  INSERT INTO login_tokens (token_hash, client_id, chat_id, is_admin, expires_at)
  SELECT digest(token, 'sha256'), $1::uuid, $2::bigint, $3::boolean, now() + interval '15 minutes'
  FROM tok
)
SELECT token FROM tok;`, '[ $json.client_id || null, $json.chat_id, !!$json.is_admin ]'));
  w.add(tg('Send Login Link', [6, 29], 'sendMessage', `{
    chat_id: ${C}.chat_id,
    text: '🔐 Your dashboard login link. It works once and expires in 15 minutes.',
    reply_markup: { inline_keyboard: [[{ text: '📊 Open dashboard', url: ${DASHBOARD} + '/auth/telegram?token=' + $json.token }]] }
  }`));
  w.link('Route', 'Create Login Token', 8);
  w.link('Create Login Token', 'Send Login Link');

  return w;
}

// ============================================================================
// 2. Generate Draft: Claude writes captions, client gets a preview with buttons.
// ============================================================================
function buildGenerate() {
  const w = new Workflow({ id: ID.generate, name: 'SM · Generate Draft', settings: settings() });
  const P = "$('Build Preview').first().json";

  w.add(subworkflowTrigger('When Called', [0, 2]));
  w.add(pg('Load Post Context', [1, 2], `
SELECT p.id AS post_id, p.brief, p.source_media_url, p.platforms,
       c.name AS client_name, c.telegram_chat_id AS chat_id,
       b.business_description, b.voice, b.audience, b.language, b.default_cta,
       b.hashtags AS brand_hashtags, b.banned_words, b.emoji_policy, b.sample_posts,
       v.fb_caption AS prev_fb, v.ig_caption AS prev_ig
FROM posts p
JOIN clients c ON c.id = p.client_id
LEFT JOIN brand_profiles b ON b.client_id = c.id
LEFT JOIN post_versions v ON v.post_id = p.id AND v.version = p.current_version
WHERE p.id = $1::uuid AND p.status = 'generating';`, '[ $json.post_id ]'));
  w.add(code('Build AI Request', [2, 2], 'generate/build-claude-request.js'));
  w.add(httpJson('Gemini: Draft Post', [3, 2], {
    url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $env.GEMINI_MODEL || "gemini-2.5-flash" }}:generateContent',
    bodyExpr: '$json.request',
    credentials: CREDENTIALS.gemini,
    timeout: 300000,
  }, { ...BRANCH_ON_ERROR, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 }));
  w.add(code('Validate Draft', [4, 1], 'generate/validate-draft.js'));
  w.add(ifTrue('Draft OK?', [5, 1], '$json.ok'));
  w.add(pg('Save Draft Version', [6, 0], `
WITH v AS (
  INSERT INTO post_versions (post_id, version, fb_caption, ig_caption, feedback, model)
  SELECT id, current_version + 1, $2, $3, NULLIF($4, ''), NULLIF($5, '')
  FROM posts WHERE id = $1::uuid AND status = 'generating'
  RETURNING post_id, version
)
UPDATE posts p SET status = 'pending_approval', current_version = v.version, error = NULL
FROM v WHERE p.id = v.post_id
RETURNING p.id AS post_id, p.current_version AS version;`,
  "[ $json.fb_caption, $json.ig_caption, $json.feedback || '', $json.model || '' ]"));
  w.add(code('Build Preview', [7, 0], 'generate/build-preview.js'));
  w.add(ifTrue('Preview Has Photo?', [8, 0], '$json.has_photo'));
  w.add(tg('Send Preview Photo', [9, -1], 'sendPhoto',
    `{ chat_id: ${P}.chat_id, photo: ${P}.photo_url, caption: '🖼 Photo for this draft' }`, CONTINUE));
  w.add(tg('Send Draft', [10, 0], 'sendMessage',
    `{ chat_id: ${P}.chat_id, text: ${P}.text, reply_markup: ${P}.reply_markup, link_preview_options: { is_disabled: true } }`));
  w.add(code('AI Error', [4, 3], 'generate/claude-error.js'));
  w.add(pg('Mark Draft Failed', [6, 3], `
UPDATE posts SET status = 'draft_failed', error = $2
WHERE id = $1::uuid
RETURNING id AS post_id, $2::text AS reason, $3::bigint AS chat_id;`, '[ $json.post_id, $json.reason, $json.chat_id ]'));
  w.add(tg('Notify Draft Failed', [7, 3], 'sendMessage',
    "{ chat_id: $json.chat_id, text: \"⚠️ I couldn't create the draft: \" + $json.reason + '.\\n\\nPlease send your brief again.' }"));

  w.chain('When Called', 'Load Post Context', 'Build AI Request', 'Gemini: Draft Post', 'Validate Draft', 'Draft OK?');
  w.link('Gemini: Draft Post', 'AI Error', 1);
  w.link('Draft OK?', 'Save Draft Version', 0);
  w.link('Draft OK?', 'Mark Draft Failed', 1);
  w.link('AI Error', 'Mark Draft Failed');
  w.chain('Save Draft Version', 'Build Preview', 'Preview Has Photo?');
  w.link('Preview Has Photo?', 'Send Preview Photo', 0);
  w.link('Preview Has Photo?', 'Send Draft', 1);
  w.link('Send Preview Photo', 'Send Draft');
  w.link('Mark Draft Failed', 'Notify Draft Failed');
  return w;
}

// ============================================================================
// 3. Publish Post: Facebook Page + Instagram Business via Graph API.
// ============================================================================
function buildPublish() {
  // Success executions are not stored: they carry the decrypted Page token.
  const w = new Workflow({ id: ID.publish, name: 'SM · Publish Post', settings: settings({ saveDataSuccessExecution: 'none' }) });
  const S = "$('Summarize').first().json";
  const IG = "$('Prep IG').first().json";

  w.add(subworkflowTrigger('When Called', [0, 3]));
  w.add(pg('Claim Post', [1, 3], `
WITH claimed AS (
  UPDATE posts SET status = 'publishing', attempts = attempts + 1, error = NULL
  WHERE id = $1::uuid AND status IN ('approved', 'scheduled')
  RETURNING *
)
SELECT cl.id AS post_id, cl.platforms, cl.source_media_url,
       cl.fb_post_id, cl.fb_permalink, cl.ig_media_id, cl.ig_permalink,
       v.fb_caption, v.ig_caption,
       c.telegram_chat_id AS chat_id, c.fb_page_id, c.ig_user_id,
       CASE WHEN c.meta_token_enc IS NULL THEN NULL ELSE pgp_sym_decrypt(c.meta_token_enc, $2) END AS access_token
FROM claimed cl
JOIN clients c ON c.id = cl.client_id
LEFT JOIN post_versions v ON v.post_id = cl.id AND v.version = cl.current_version;`,
  '[ $json.post_id, $env.TOKEN_ENCRYPTION_KEY ]'));
  w.add(code('Plan Publish', [2, 3], 'publish/plan-publish.js'));

  w.add(ifTrue('Publish to Facebook?', [3, 3], '$json.do_fb'));
  // No retries on publish calls: a timeout may still have posted, and retrying would duplicate it.
  w.add(graph('FB: Publish', [4, 2], {
    method: 'POST', path: '{{ $json.fb_request.path }}', tokenExpr: '$json.access_token', bodyExpr: '$json.fb_request.body',
  }, BRANCH_ON_ERROR));
  w.add(code('FB Done', [5, 1], 'publish/fb-done.js'));
  w.add(code('FB Failed', [5, 3], 'publish/fb-failed.js'));
  w.add(code('Prep IG', [6, 3], 'return [{ json: $input.first().json }];'));

  w.add(ifTrue('Publish to Instagram?', [7, 3], '$json.do_ig'));
  w.add(graph('IG: Create Container', [8, 2], {
    method: 'POST', path: '{{ $json.ig_user_id }}/media', tokenExpr: '$json.access_token',
    bodyExpr: '{ image_url: $json.media_url, caption: $json.ig_caption }',
  }, BRANCH_ON_ERROR));
  w.add(waitSeconds('Wait For Processing', [9, 2], 3));
  w.add(graph('IG: Check Status', [10, 2], {
    path: "{{ $('IG: Create Container').first().json.id }}?fields=status_code,status", tokenExpr: `${IG}.access_token`,
  }, { ...BRANCH_ON_ERROR, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }));
  w.add(code('Eval Container', [11, 2], 'publish/eval-container.js'));
  w.add(switchIndex('Container Ready?', [12, 2], 3, '$json.route'));
  w.add(graph('IG: Publish', [13, 1], {
    method: 'POST', path: `{{ ${IG}.ig_user_id }}/media_publish`, tokenExpr: `${IG}.access_token`,
    bodyExpr: "{ creation_id: $('IG: Create Container').first().json.id }",
  }, BRANCH_ON_ERROR));
  w.add(graph('IG: Get Permalink', [14, 1], {
    path: '{{ $json.id }}?fields=permalink', tokenExpr: `${IG}.access_token`,
  }, CONTINUE));
  w.add(code('IG Done', [15, 1], 'publish/ig-done.js'));
  w.add(code('IG Failed', [14, 4], 'publish/ig-failed.js'));

  w.add(code('Summarize', [16, 3], 'publish/summarize.js'));
  w.add(pg('Save Result', [17, 3], `
WITH upd AS (
  UPDATE posts SET
    status = $2,
    fb_post_id = NULLIF($3, ''), fb_permalink = NULLIF($4, ''),
    ig_media_id = NULLIF($5, ''), ig_permalink = NULLIF($6, ''),
    ig_container_id = COALESCE(NULLIF($7, ''), ig_container_id),
    error = NULLIF($8, ''),
    published_at = CASE WHEN $2 IN ('published', 'partially_published') THEN COALESCE(published_at, now()) ELSE published_at END
  WHERE id = $1::uuid
  RETURNING id, client_id
)
INSERT INTO audit_log (client_id, post_id, action, detail)
SELECT client_id, id, 'publish_' || $2, jsonb_build_object('error', NULLIF($8, '')) FROM upd
RETURNING post_id;`,
  '[ $json.post_id, $json.status, $json.fb_post_id, $json.fb_permalink, $json.ig_media_id, $json.ig_permalink, $json.ig_container_id, $json.error ]'));
  w.add(tg('Notify Client', [18, 2], 'sendMessage',
    `{ chat_id: ${S}.chat_id, text: ${S}.text, reply_markup: ${S}.reply_markup, link_preview_options: { is_disabled: true } }`));
  w.add(ifTrue('Alert Admin?', [18, 4], `${S}.status !== 'published' && !!$env.ADMIN_TELEGRAM_CHAT_ID`));
  w.add(tg('Alert Admin', [19, 4], 'sendMessage',
    `{ chat_id: $env.ADMIN_TELEGRAM_CHAT_ID, text: '⚠️ Publish problem, post ' + ${S}.post_id + '\\n\\n' + ${S}.text }`, CONTINUE));

  w.chain('When Called', 'Claim Post', 'Plan Publish', 'Publish to Facebook?');
  w.link('Publish to Facebook?', 'FB: Publish', 0);
  w.link('Publish to Facebook?', 'Prep IG', 1);
  w.link('FB: Publish', 'FB Done', 0);
  w.link('FB: Publish', 'FB Failed', 1);
  w.link('FB Done', 'Prep IG');
  w.link('FB Failed', 'Prep IG');
  w.link('Prep IG', 'Publish to Instagram?');
  w.link('Publish to Instagram?', 'IG: Create Container', 0);
  w.link('Publish to Instagram?', 'Summarize', 1);
  w.link('IG: Create Container', 'Wait For Processing', 0);
  w.link('IG: Create Container', 'IG Failed', 1);
  w.link('Wait For Processing', 'IG: Check Status');
  w.link('IG: Check Status', 'Eval Container', 0);
  w.link('IG: Check Status', 'IG Failed', 1);
  w.link('Eval Container', 'Container Ready?');
  w.link('Container Ready?', 'IG: Publish', 0);
  w.link('Container Ready?', 'Wait For Processing', 1);
  w.link('Container Ready?', 'IG Failed', 2);
  w.link('IG: Publish', 'IG: Get Permalink', 0);
  w.link('IG: Publish', 'IG Failed', 1);
  w.link('IG: Get Permalink', 'IG Done');
  w.link('IG Done', 'Summarize');
  w.link('IG Failed', 'Summarize');
  w.link('Summarize', 'Save Result');
  w.link('Save Result', 'Notify Client');
  w.link('Save Result', 'Alert Admin?');
  w.link('Alert Admin?', 'Alert Admin', 0);
  return w;
}

// ============================================================================
// 4. Scheduler: publishes due posts, unsticks crashed runs.
// ============================================================================
function buildScheduler() {
  const w = new Workflow({ id: ID.scheduler, name: 'SM · Scheduler', settings: settings({ saveDataSuccessExecution: 'none' }) });
  w.add(scheduleEveryMinutes('Every Minute', [0, 0], 1));
  w.add(pg('Fail Stuck Posts', [1, 0], `
UPDATE posts SET
  status = CASE WHEN status = 'publishing' THEN 'failed' ELSE 'draft_failed' END,
  error = CASE WHEN status = 'publishing'
    THEN 'Publishing did not finish. Check the Page before retrying, it may already be posted.'
    ELSE 'Draft generation did not finish.' END
WHERE status IN ('publishing', 'generating') AND updated_at < now() - interval '15 minutes';`, null, { alwaysOutputData: true }));
  w.add(pg('Find Due Posts', [2, 0], `
SELECT id AS post_id FROM posts
WHERE status = 'scheduled' AND publish_at <= now()
ORDER BY publish_at
LIMIT 25;`, null));
  w.add(executeWorkflow('Publish Due Post', [3, 0], ID.publish, { mode: 'each', wait: false }));
  w.chain('Every Minute', 'Fail Stuck Posts', 'Find Due Posts', 'Publish Due Post');
  return w;
}

// ============================================================================
// 5. Error Handler: any unhandled workflow error → admin Telegram.
// ============================================================================
function buildErrors() {
  const w = new Workflow({
    id: ID.errors,
    name: 'SM · Error Handler',
    settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
  });
  w.add(errorTrigger('On Workflow Error', [0, 0]));
  w.add(code('Format Alert', [1, 0], 'errors/format-alert.js'));
  w.add(ifTrue('Admin Configured?', [2, 0], '!!$env.ADMIN_TELEGRAM_CHAT_ID'));
  w.add(tg('Alert Admin', [3, 0], 'sendMessage', '{ chat_id: $env.ADMIN_TELEGRAM_CHAT_ID, text: $json.text }'));
  w.chain('On Workflow Error', 'Format Alert', 'Admin Configured?', 'Alert Admin');
  return w;
}

// ============================================================================
const workflows = [
  ['01-telegram-router.json', buildRouter()],
  ['02-generate-draft.json', buildGenerate()],
  ['03-publish-post.json', buildPublish()],
  ['04-scheduler.json', buildScheduler()],
  ['05-error-handler.json', buildErrors()],
];

const errors = workflows.flatMap(([, wf]) => validate(wf));
if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [file, wf] of workflows) {
  writeFileSync(join(OUT_DIR, file), JSON.stringify(wf.toJSON(), null, 2) + '\n');
  console.log(`✓ ${file}  (${wf.nodes.length} nodes)`);
}
