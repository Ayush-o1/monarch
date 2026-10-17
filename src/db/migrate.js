import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyAppRoleGrants } from './roles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function computeChecksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function migrate({
  pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  let clientPool = pool;
  let shouldClosePool = false;

  if (!clientPool) {
    const isTest = process.env.NODE_ENV === 'test';
    const migrateUrl = isTest
      ? process.env.TEST_MIGRATE_DATABASE_URL ||
        process.env.MIGRATE_DATABASE_URL
      : process.env.MIGRATE_DATABASE_URL;

    if (!migrateUrl) {
      throw new Error(
        'MIGRATE_DATABASE_URL is required for database migrations'
      );
    }

    clientPool = new pg.Pool({ connectionString: migrateUrl });
    shouldClosePool = true;
  }

  const client = await clientPool.connect();

  try {
    // Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Fetch already applied migrations
    const res = await client.query(
      `SELECT filename, checksum FROM schema_migrations ORDER BY filename ASC`
    );
    const applied = new Map(res.rows.map((r) => [r.filename, r.checksum]));

    // Read and sort migration files
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const sqlFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .map((e) => e.name)
      .sort();

    let appliedCount = 0;

    for (const file of sqlFiles) {
      const filePath = path.join(migrationsDir, file);
      const content = await fs.readFile(filePath, 'utf8');
      const checksum = computeChecksum(content);

      if (applied.has(file)) {
        const recordedChecksum = applied.get(file);
        if (recordedChecksum !== checksum) {
          throw new Error(
            `Migration checksum mismatch for ${file}: recorded ${recordedChecksum}, found ${checksum}`
          );
        }
        continue;
      }

      // Apply pending migration in a transaction
      await client.query('BEGIN');
      try {
        await client.query(content);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
          [file, checksum]
        );
        await client.query('COMMIT');
        appliedCount++;
        console.log(`Applied migration: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Failed to apply migration ${file}: ${err.message}`);
      }
    }

    if (appliedCount === 0) {
      console.log('Database is up to date. No migrations to apply.');
    } else {
      console.log(`Successfully applied ${appliedCount} migration(s).`);
    }

    // Call applyAppRoleGrants whenever APP_DB_PASSWORD is set
    if (process.env.APP_DB_PASSWORD) {
      const role = process.env.APP_DB_USER || 'monarch_app';
      const password = process.env.APP_DB_PASSWORD;
      const dbRes = await client.query('SELECT current_database() AS db_name');
      const dbName = dbRes.rows[0].db_name;
      await applyAppRoleGrants(clientPool, { dbName, role, password });
    }

    return { appliedCount };
  } finally {
    client.release();
    if (shouldClosePool) {
      await clientPool.end();
    }
  }
}

// Run CLI directly if invoked as script
const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  migrate()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}
