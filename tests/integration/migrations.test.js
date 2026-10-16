import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pool, ensureTestDb } from '../helpers/db.js';
import { migrate } from '../../src/db/migrate.js';

describe('Database and Migrations', () => {
  before(async () => {
    await ensureTestDb();
  });

  after(async () => {
    await pool.end();
  });

  it('running migrate when up to date applies 0 migrations', async () => {
    const result = await migrate({ pool });
    assert.equal(result.appliedCount, 0);
  });

  it('fails at database on case-insensitive duplicate email insert', async () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const emailPrefix = `test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const emailUpper = `${emailPrefix}@Example.COM`;
    const emailLower = `${emailPrefix}@example.com`;

    // First insert succeeds
    await pool.query(
      `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
      [id1, 'User One', emailUpper, 'hash123']
    );

    // Second insert with different casing must fail with unique violation (23505)
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)`,
          [id2, 'User Two', emailLower, 'hash456']
        );
      },
      (err) => {
        assert.equal(err.code, '23505');
        assert.match(err.message, /users_lower_email_idx/i);
        return true;
      }
    );
  });

  it('refuses to run if an applied migration checksum changed', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrations-test-'));

    try {
      // Create a mock migration file with same name as applied migration 001_users_sessions.sql but tampered content
      const tamperedFile = path.join(tmpDir, '001_users_sessions.sql');
      await fs.writeFile(tamperedFile, '-- tampered content\nSELECT 1;');

      await assert.rejects(async () => {
        await migrate({ pool, migrationsDir: tmpDir });
      }, /Migration checksum mismatch for 001_users_sessions\.sql/i);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
