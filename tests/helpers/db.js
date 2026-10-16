import { pool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';

let migrated = false;

export async function ensureTestDb() {
  if (!migrated) {
    await migrate({ pool });
    migrated = true;
  }
}

export { pool };
