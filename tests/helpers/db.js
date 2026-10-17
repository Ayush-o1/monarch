import pg from 'pg';
import { pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import config from '../../src/config.js';

let migrated = false;

const ownerUrl =
  config.migrateDatabaseUrl ||
  process.env.TEST_MIGRATE_DATABASE_URL ||
  process.env.MIGRATE_DATABASE_URL;

export const ownerPool = new pg.Pool({
  connectionString: ownerUrl,
});

export async function ensureTestDb() {
  if (!migrated) {
    await migrate({ pool: ownerPool });
    migrated = true;
  }
}

export { pool };
