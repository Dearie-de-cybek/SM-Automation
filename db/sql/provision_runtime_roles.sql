\set ON_ERROR_STOP on
\getenv app_db_user APP_DB_USER
\getenv app_db_password APP_DB_PASSWORD
\getenv operator_db_user OPERATOR_DB_USER
\getenv operator_db_password OPERATOR_DB_PASSWORD
\getenv worker_db_user WORKER_DB_USER
\getenv worker_db_password WORKER_DB_PASSWORD

CREATE OR REPLACE FUNCTION pg_temp.provision_runtime_logins(
  login_names text[], login_passwords text[], memberships text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  position integer;
  login_name text;
  login_password text;
  membership text;
  privileged boolean;
BEGIN
  IF array_length(login_names, 1) <> 3 OR array_length(login_passwords, 1) <> 3
     OR array_length(memberships, 1) <> 3 THEN
    RAISE EXCEPTION 'Exactly three runtime database logins are required';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(login_names) item WHERE item IS NULL OR item = '')
     OR EXISTS (SELECT 1 FROM unnest(login_passwords) item WHERE item IS NULL OR item = '') THEN
    RAISE EXCEPTION 'Runtime database user names and passwords must not be empty';
  END IF;
  IF (SELECT count(DISTINCT item) FROM unnest(login_names) item) <> 3 THEN
    RAISE EXCEPTION 'Runtime database user names must be distinct';
  END IF;
  IF login_names && memberships THEN
    RAISE EXCEPTION 'Runtime login names must differ from group role names';
  END IF;

  FOR position IN 1..3 LOOP
    login_name := login_names[position];
    login_password := login_passwords[position];
    membership := memberships[position];

    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = membership) THEN
      RAISE EXCEPTION 'Required group role % does not exist', membership;
    END IF;

    SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      INTO privileged
      FROM pg_catalog.pg_roles
     WHERE rolname = login_name;

    IF FOUND AND privileged THEN
      RAISE EXCEPTION 'Refusing to repurpose privileged role %', login_name;
    ELSIF FOUND AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_auth_members role_membership
        JOIN pg_catalog.pg_roles member_role ON member_role.oid = role_membership.member
        JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = role_membership.roleid
       WHERE member_role.rolname = login_name
         AND granted_role.rolname <> membership
    ) THEN
      RAISE EXCEPTION 'Unexpected role membership for %', login_name;
    ELSIF FOUND AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_auth_members role_membership
        JOIN pg_catalog.pg_roles member_role ON member_role.oid = role_membership.member
        JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = role_membership.roleid
       WHERE member_role.rolname = login_name
         AND granted_role.rolname = membership
    ) THEN
      RAISE EXCEPTION 'Existing unmanaged role % must not be repurposed', login_name;
    ELSIF FOUND THEN
      EXECUTE format(
        'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
        login_name, login_password
      );
    ELSE
      EXECUTE format(
        'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',
        login_name, login_password
      );
      EXECUTE format('GRANT %I TO %I', membership, login_name);
    END IF;
  END LOOP;
END
$$;

SELECT pg_temp.provision_runtime_logins(
  ARRAY[:'app_db_user', :'operator_db_user', :'worker_db_user'],
  ARRAY[:'app_db_password', :'operator_db_password', :'worker_db_password'],
  ARRAY['sm_app', 'sm_operator', 'sm_worker']
);
