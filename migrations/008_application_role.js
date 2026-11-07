/* eslint-disable @typescript-eslint/no-require-imports */
require('dotenv').config();

exports.shorthands = undefined;

exports.up = (pgm) => {
  const appUser = process.env.APP_DB_USER;
  const appPassword = process.env.APP_DB_PASSWORD;

  if (!appUser || !appPassword) {
    throw new Error(
      '008_application_role: missing required APP_DB_USER or APP_DB_PASSWORD in environment'
    );
  }

  // Validate that credentials contain only safe characters (alphanumeric and underscore)
  if (!/^[a-zA-Z0-9_]+$/.test(appUser)) {
    throw new Error(
      '008_application_role: APP_DB_USER must contain only alphanumeric characters and underscores'
    );
  }
  if (!/^[a-zA-Z0-9]+$/.test(appPassword)) {
    throw new Error(
      '008_application_role: APP_DB_PASSWORD must contain only alphanumeric characters'
    );
  }

  // 1. Create login role if it does not exist, and set/update password
  pgm.sql(`
    DO $role_init$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${appUser}') THEN
        CREATE ROLE "${appUser}" WITH LOGIN PASSWORD '${appPassword}';
      ELSE
        ALTER ROLE "${appUser}" WITH LOGIN PASSWORD '${appPassword}';
      END IF;
    END
    $role_init$;
  `);

  // 2. Revoke CREATE on schema public from PUBLIC and from the application role
  pgm.sql(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE CREATE ON SCHEMA public FROM "${appUser}";
  `);

  // 3. Grant database connection and schema usage
  pgm.sql(`
    DO $conn_grant$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${appUser}');
    END
    $conn_grant$;

    GRANT USAGE ON SCHEMA public TO "${appUser}";
  `);

  // 4. Grant SELECT, INSERT, UPDATE, DELETE on domain tables EXCEPT audit_log
  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      department,
      faculty,
      users,
      grant_record,
      grant_account,
      expenditure,
      intellectual_property,
      ip_author,
      grant_ip
    TO "${appUser}";
  `);

  // 5. Grant only SELECT and INSERT on audit_log (no UPDATE, DELETE, or TRUNCATE)
  pgm.sql(`
    GRANT SELECT, INSERT ON TABLE audit_log TO "${appUser}";
  `);

  // 6. Grant sequence USAGE and SELECT for identity column generation
  pgm.sql(`
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${appUser}";
  `);
};

exports.down = (pgm) => {
  const appUser = process.env.APP_DB_USER;
  if (!appUser) {
    throw new Error(
      '008_application_role: missing required APP_DB_USER in environment for down migration'
    );
  }
  if (!/^[a-zA-Z0-9_]+$/.test(appUser)) {
    throw new Error('008_application_role: invalid APP_DB_USER format');
  }

  // 1. Revoke privileges on sequences
  pgm.sql(`
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM "${appUser}";
  `);

  // 2. Revoke privileges on domain tables and audit_log
  pgm.sql(`
    REVOKE ALL PRIVILEGES ON TABLE
      department,
      faculty,
      users,
      grant_record,
      grant_account,
      expenditure,
      intellectual_property,
      ip_author,
      grant_ip,
      audit_log
    FROM "${appUser}";
  `);

  // 3. Revoke schema usage and database connection privileges
  pgm.sql(`
    REVOKE USAGE ON SCHEMA public FROM "${appUser}";
    DO $conn_revoke$
    BEGIN
      EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), '${appUser}');
    END
    $conn_revoke$;
  `);

  // Note on cluster role preservation:
  // The login role "${appUser}" is deliberately left in place because PostgreSQL
  // roles are cluster-wide entities shared across databases (e.g. development and test).
  // Revoking database and table privileges completely detaches its access while leaving
  // the cluster-level login intact.
};
