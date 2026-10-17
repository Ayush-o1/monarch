import { pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * Applies limited privileges for the application database role.
 * Safe SQL generation using PostgreSQL SELECT format(...) with %I and %L.
 *
 * @param {import('pg').Pool} ownerPool
 * @param {object} options
 * @param {string} options.dbName
 * @param {string} options.role
 * @param {string} options.password
 */
export async function applyAppRoleGrants(
  ownerPool,
  { dbName, role, password }
) {
  if (!ownerPool) {
    throw new Error('ownerPool is required');
  }
  if (!dbName || !role || !password) {
    throw new Error('dbName, role, and password are required');
  }

  // 1. Check if role exists
  const roleCheck = await ownerPool.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1::text',
    [role]
  );
  const exists = roleCheck.rowCount > 0;

  // 2. CREATE or ALTER role with safe formatting
  const roleFormat = exists
    ? "SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql"
    : "SELECT format('CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql";

  const roleRes = await ownerPool.query(roleFormat, [role, password]);
  await ownerPool.query(roleRes.rows[0].sql);

  // Helper for formatting and executing SQL safely
  async function execFormat(formatStr, params) {
    const placeholders = params.map((_, i) => `$${i + 1}::text`).join(', ');
    const query = placeholders
      ? `SELECT format(${formatStr}, ${placeholders}) AS sql`
      : `SELECT format(${formatStr}) AS sql`;
    const res = await ownerPool.query(query, params);
    await ownerPool.query(res.rows[0].sql);
  }

  // 3. GRANT CONNECT on database
  await execFormat("'GRANT CONNECT ON DATABASE %I TO %I'", [dbName, role]);

  // 4. Schema public: GRANT USAGE, REVOKE CREATE
  await execFormat("'GRANT USAGE ON SCHEMA public TO %I'", [role]);
  await execFormat("'REVOKE CREATE ON SCHEMA public FROM %I'", [role]);

  // 5. Tables: REVOKE ALL, then GRANT SELECT, INSERT, UPDATE, DELETE on all tables
  await execFormat("'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I'", [
    role,
  ]);
  await execFormat(
    "'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I'",
    [role]
  );

  // 6. REVOKE UPDATE, DELETE, TRUNCATE on events (keeps SELECT, INSERT only)
  const hasEvents = await ownerPool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'events'"
  );
  if (hasEvents.rowCount > 0) {
    await execFormat(
      "'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE events FROM %I'",
      [role]
    );
  }

  // 7. REVOKE ALL on schema_migrations
  const hasMigrations = await ownerPool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'"
  );
  if (hasMigrations.rowCount > 0) {
    await execFormat("'REVOKE ALL ON TABLE schema_migrations FROM %I'", [role]);
  }

  // 8. Sequences: GRANT USAGE, SELECT on all sequences
  await execFormat(
    "'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I'",
    [role]
  );
}

export async function runRolesCli() {
  const isTest = process.env.NODE_ENV === 'test';
  const migrateUrl = isTest
    ? process.env.TEST_MIGRATE_DATABASE_URL || process.env.MIGRATE_DATABASE_URL
    : process.env.MIGRATE_DATABASE_URL;

  if (!migrateUrl) {
    throw new Error(
      'MIGRATE_DATABASE_URL is required to configure database roles'
    );
  }

  const role = process.env.APP_DB_USER || 'monarch_app';
  const password = process.env.APP_DB_PASSWORD;

  if (!password) {
    throw new Error('APP_DB_PASSWORD is required to configure database roles');
  }

  const urlObj = new URL(migrateUrl);
  const dbName = urlObj.pathname.replace(/^\//, '');

  const ownerPool = new pg.Pool({ connectionString: migrateUrl });
  try {
    await applyAppRoleGrants(ownerPool, { dbName, role, password });
    console.log(`Successfully configured role ${role} on database ${dbName}`);
  } finally {
    await ownerPool.end();
  }
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  runRolesCli()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Role setup failed:', err.message);
      process.exit(1);
    });
}
