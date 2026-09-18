import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('tenant-security migration installs forced RLS and narrow runtime roles', async () => {
  const migration = await read('db/migrations/004_tenant_security.sql');

  const requiredRoles = ['sm_app', 'sm_operator', 'sm_worker', 'sm_n8n_core'];
  const roleLoop = migration.match(
    /FOREACH role_name IN ARRAY ARRAY\[(?<roles>[^\]]+)\] LOOP/i,
  );
  assert.ok(roleLoop?.groups?.roles, 'migration must enumerate runtime group roles');
  const declaredRoles = [...roleLoop.groups.roles.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(declaredRoles, requiredRoles);
  assert.match(
    migration,
    /CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS/i,
  );
  assert.match(migration, /FROM pg_catalog\.pg_auth_members inherited_membership/i);
  assert.match(migration, /WHERE inherited_membership\.member = runtime_role\.oid/i);
  assert.match(migration, /RAISE EXCEPTION 'Refusing incompatible runtime group role %'/i);

  const tenantTables = [
    'clients',
    'brand_profiles',
    'posts',
    'post_versions',
    'chat_sessions',
    'audit_log',
    'login_tokens',
    'campaigns',
    'provider_connections',
    'social_accounts',
    'post_targets',
    'comments',
    'comment_replies',
    'automation_policies',
    'knowledge_sources',
    'knowledge_chunks',
    'usage_counters',
    'oauth_states',
    'content_requests',
  ];

  for (const table of tenantTables) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'), `${table} must force RLS`);
    assert.match(migration, new RegExp(`CREATE POLICY ${table}_worker_all`, 'i'), `${table} needs an explicit worker policy`);
  }

  assert.match(migration, /REVOKE CONNECT ON DATABASE .* FROM PUBLIC/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION app_store_webhook_event\([\s\S]+?RETURNS bigint[\s\S]+?SECURITY DEFINER[\s\S]+?SET search_path = pg_catalog, pg_temp[\s\S]+?ON CONFLICT \(provider, event_key\) DO NOTHING/i,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION app_store_webhook_event\(text, text, jsonb\)[\s\S]+?FROM PUBLIC, sm_operator, sm_worker, sm_n8n_core/i,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION app_store_webhook_event\(text, text, jsonb\) TO sm_app/i,
  );
  assert.match(migration, /REVOKE ALL ON FUNCTION app_admin_list_clients\(\) FROM PUBLIC/i);
});

test('compose never gives a long-running service the bootstrap database login', async () => {
  const [compose, envExample, provision] = await Promise.all([
    read('docker-compose.yml'),
    read('.env.example'),
    read('db/sql/provision_runtime_roles.sql'),
  ]);

  assert.match(compose, /DATABASE_URL: postgres:\/\/\$\{APP_DB_USER\}/);
  assert.match(compose, /DATABASE_URL: postgres:\/\/\$\{WORKER_DB_USER\}/);
  assert.match(compose, /OPERATOR_DATABASE_URL: postgres:\/\/\$\{OPERATOR_DB_USER\}/);
  assert.match(compose, /DB_POSTGRESDB_USER: \$\{N8N_DB_USER\}/);
  assert.doesNotMatch(compose, /DB_POSTGRESDB_USER: \$\{POSTGRES_USER\}/);

  for (const key of [
    'APP_DB_USER',
    'APP_DB_PASSWORD',
    'OPERATOR_DB_USER',
    'OPERATOR_DB_PASSWORD',
    'WORKER_DB_USER',
    'WORKER_DB_PASSWORD',
    'N8N_DB_USER',
    'N8N_DB_PASSWORD',
  ]) {
    assert.match(envExample, new RegExp(`^${key}=`, 'm'), `${key} must be documented`);
  }

  assert.match(provision, /NOBYPASSRLS/);
  assert.match(provision, /Runtime database user names must be distinct/);
});
