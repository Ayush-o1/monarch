import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool as defaultPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function computeChecksum(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function migrate({
  pool = defaultPool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  const client = await pool.connect();

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

    return { appliedCount };
  } finally {
    client.release();
  }
}

// Run CLI directly if invoked as script
const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  migrate()
    .then(async () => {
      await defaultPool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await defaultPool.end().catch(() => {});
      process.exit(1);
    });
}
