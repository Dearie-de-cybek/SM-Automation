import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import postgres from 'postgres';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const operatorUrl = process.env.TEST_OPERATOR_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
const n8nUrl = process.env.TEST_N8N_DATABASE_URL;
const run = adminUrl && appUrl && operatorUrl && workerUrl && n8nUrl ? test : test.skip;

const clientA = '10000000-0000-4000-8000-000000000001';
const clientB = '10000000-0000-4000-8000-000000000002';
const postA = '20000000-0000-4000-8000-000000000001';
const postB = '20000000-0000-4000-8000-000000000002';
const versionA = 9_000_001;
const versionB = 9_000_002;
const webhookEventKey = `security-integration-${randomUUID()}`;

let admin: postgres.Sql;
let app: postgres.Sql;
let operator: postgres.Sql;
let worker: postgres.Sql;
let n8n: postgres.Sql;

before(async () => {
  if (!adminUrl || !appUrl || !operatorUrl || !workerUrl || !n8nUrl) return;
  admin = postgres(adminUrl, { max: 1 });
  app = postgres(appUrl, { max: 1 });
  operator = postgres(operatorUrl, { max: 1 });
  worker = postgres(workerUrl, { max: 1 });
  n8n = postgres(n8nUrl, { max: 1 });

  const [{ database }] = await admin<{ database: string }[]>`SELECT current_database() AS database`;
  assert.match(database, /test$/, 'integration tests require a dedicated database ending in test');

  await admin`
    INSERT INTO clients (id, name, timezone, telegram_link_code)
    VALUES
      (${clientA}::uuid, 'Tenant A', 'UTC', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      (${clientB}::uuid, 'Tenant B', 'UTC', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
  await admin`
    INSERT INTO posts (id, client_id, brief, platforms)
    VALUES
      (${postA}::uuid, ${clientA}::uuid, 'A post', ARRAY['facebook']),
      (${postB}::uuid, ${clientB}::uuid, 'B post', ARRAY['facebook'])
    ON CONFLICT (id) DO UPDATE SET brief = EXCLUDED.brief`;
  await admin`
    INSERT INTO post_versions (id, post_id, version, fb_caption, ig_caption)
    VALUES
      (${versionA}, ${postA}::uuid, 1, 'A', 'A'),
      (${versionB}, ${postB}::uuid, 1, 'B', 'B')
    ON CONFLICT (id) DO NOTHING`;
});

after(async () => {
  await Promise.all(
    [admin, app, operator, worker, n8n].filter(Boolean).map((sql) => sql.end({ timeout: 5 })),
  );
});

run('all tenant tables force RLS', async () => {
  const expected = [
    'audit_log', 'automation_policies', 'brand_profiles', 'campaigns', 'chat_sessions',
    'clients', 'comment_replies', 'comments', 'content_requests', 'knowledge_chunks',
    'knowledge_sources', 'login_tokens', 'oauth_states', 'post_targets', 'post_versions',
    'posts', 'provider_connections', 'social_accounts', 'usage_counters',
  ];
  const rows = await admin<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relname IN ${admin(expected)}
     ORDER BY relname`;
  assert.deepEqual(rows.map((row) => row.relname), expected);
  assert.ok(rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
});

run('dashboard fails closed and cannot cross tenant through direct or indirect rows', async () => {
  assert.deepEqual(await app<{ id: string }[]>`SELECT id FROM clients`, []);

  const visible = await app.begin(async (tx) => {
    await tx`SELECT set_config('app.client_id', ${clientA}, true)`;
    const clients = await tx<{ id: string }[]>`SELECT id FROM clients ORDER BY id`;
    const posts = await tx<{ id: string }[]>`SELECT id FROM posts ORDER BY id`;
    const versions = await tx<{ id: string }[]>`SELECT id::text AS id FROM post_versions ORDER BY id`;
    const changed = await tx`UPDATE clients SET timezone = 'Africa/Lagos' WHERE id = ${clientB}::uuid`;
    return { clients, posts, versions, changed: changed.count };
  });

  assert.deepEqual(visible.clients.map((row) => row.id), [clientA]);
  assert.deepEqual(visible.posts.map((row) => row.id), [postA]);
  assert.deepEqual(visible.versions.map((row) => row.id), [String(versionA)]);
  assert.equal(visible.changed, 0);
});

run('pre-auth and operator capabilities are narrow functions only', async () => {
  await assert.rejects(app`SELECT token_hash FROM login_tokens`, /permission denied/i);
  await assert.rejects(operator`SELECT id FROM clients`, /permission denied/i);
  await assert.rejects(app`SELECT * FROM app_admin_list_clients()`, /permission denied/i);

  const signup = await app<{ name: string }[]>`
    SELECT * FROM app_signup_client('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`;
  assert.deepEqual(signup, [{ name: 'Tenant A' }]);

  const clients = await operator<{ id: string }[]>`SELECT id FROM app_admin_list_clients() ORDER BY id`;
  assert.deepEqual(clients.map((row) => row.id), [clientA, clientB]);
});

run('dashboard can store a webhook only through the deduplicating ingress function', async () => {
  await assert.rejects(
    app`INSERT INTO webhook_events (provider, event_key, payload) VALUES ('telegram', ${webhookEventKey}, '{}'::jsonb)`,
    /permission denied/i,
  );

  const [stored] = await app<{ event_id: string | null }[]>`
    SELECT app_store_webhook_event(
      'telegram', ${webhookEventKey}, ${JSON.stringify({ update_id: 42 })}::jsonb
    )::text AS event_id`;
  assert.match(stored?.event_id ?? '', /^\d+$/);

  const [duplicate] = await app<{ event_id: string | null }[]>`
    SELECT app_store_webhook_event(
      'telegram', ${webhookEventKey}, ${JSON.stringify({ update_id: 99 })}::jsonb
    )::text AS event_id`;
  assert.equal(duplicate?.event_id, null);

  const [persisted] = await worker<{ payload: { update_id: number } }[]>`
    SELECT payload FROM webhook_events WHERE provider = 'telegram' AND event_key = ${webhookEventKey}`;
  assert.deepEqual(persisted?.payload, { update_id: 42 });
});

run('worker access is explicit while runtime logins remain unprivileged', async () => {
  const clients = await worker<{ id: string }[]>`SELECT id FROM clients ORDER BY id`;
  assert.deepEqual(clients.map((row) => row.id), [clientA, clientB]);

  const roles = await admin<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]>`
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
      FROM pg_roles
     WHERE rolname IN (
       'sm_app', 'sm_operator', 'sm_worker', 'sm_n8n_core',
       'sm_app_test', 'sm_operator_test', 'sm_worker_test', 'sm_n8n_test'
     )
     ORDER BY rolname`;
  assert.equal(roles.length, 8);
  assert.ok(roles.every((role) => !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolbypassrls));

  const nestedMemberships = await admin<{ member: string; inherited_role: string }[]>`
    SELECT member_role.rolname AS member, inherited_role.rolname AS inherited_role
      FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_roles inherited_role ON inherited_role.oid = membership.roleid
     WHERE member_role.rolname IN ('sm_app', 'sm_operator', 'sm_worker', 'sm_n8n_core')`;
  assert.deepEqual(nestedMemberships, []);
});

run('PUBLIC and n8n-core cannot connect to app database', async () => {
  const [{ database }] = await admin<{ database: string }[]>`SELECT current_database() AS database`;
  const [{ allowed }] = await admin<{ allowed: boolean }[]>`
    SELECT has_database_privilege('public', ${database}, 'CONNECT') AS allowed`;
  assert.equal(allowed, false);

  await n8n`SELECT 1`;
  const appDatabaseUrlForN8n = new URL(n8nUrl as string);
  appDatabaseUrlForN8n.pathname = `/${database}`;
  const forbidden = postgres(appDatabaseUrlForN8n.toString(), { max: 1, connect_timeout: 2 });
  await assert.rejects(forbidden`SELECT 1`, /permission denied for database/i);
  await forbidden.end({ timeout: 1 }).catch(() => undefined);
});
