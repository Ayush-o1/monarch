import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, ownerPool, ensureTestDb } from '../helpers/db.js';

describe('Database Role Separation and Privilege Hardening (Phase 10)', () => {
  let tenancyId;
  let eventId;

  before(async () => {
    await ensureTestDb();

    // Create a tenancy and event via ownerPool to have existing rows to test against
    const tenantId = crypto.randomUUID();
    tenancyId = crypto.randomUUID();

    await ownerPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Role Tester', $2, 'dummyhash')`,
      [tenantId, `role_test_${Date.now()}@example.com`]
    );

    await ownerPool.query(
      `INSERT INTO tenancies (id, tenant_id, property_label, deposit_paise)
       VALUES ($1, $2, 'Role Test Tenancy', 5000000)`,
      [tenancyId, tenantId]
    );

    const evRes = await ownerPool.query(
      `INSERT INTO events (tenancy_id, actor_type, actor_label, type, payload)
       VALUES ($1, 'tenant', 'Role Tester', 'test_event', '{}'::jsonb)
       RETURNING id`,
      [tenancyId]
    );
    eventId = evRes.rows[0].id;
  });

  after(async () => {
    await pool.end();
    await ownerPool.end();
  });

  it('UPDATE on events table fails with SQLSTATE 42501 (permission denied)', async () => {
    await assert.rejects(
      () =>
        pool.query(`UPDATE events SET actor_label = 'Hacked' WHERE id = $1`, [
          eventId,
        ]),
      (err) => {
        assert.equal(err.code, '42501');
        assert.match(err.message, /permission denied/i);
        return true;
      }
    );
  });

  it('DELETE FROM events table fails with SQLSTATE 42501 (permission denied)', async () => {
    await assert.rejects(
      () => pool.query(`DELETE FROM events WHERE id = $1`, [eventId]),
      (err) => {
        assert.equal(err.code, '42501');
        assert.match(err.message, /permission denied/i);
        return true;
      }
    );
  });

  it('TRUNCATE events table fails with SQLSTATE 42501 (permission denied)', async () => {
    await assert.rejects(
      () => pool.query(`TRUNCATE events`),
      (err) => {
        assert.equal(err.code, '42501');
        assert.match(err.message, /permission denied/i);
        return true;
      }
    );
  });

  it('ALTER TABLE events DISABLE TRIGGER ALL fails (must be owner)', async () => {
    await assert.rejects(
      () => pool.query(`ALTER TABLE events DISABLE TRIGGER ALL`),
      (err) => {
        assert.match(err.message, /must be owner/i);
        return true;
      }
    );
  });

  it('CREATE TABLE fails with permission denied', async () => {
    await assert.rejects(
      () => pool.query(`CREATE TABLE unauthorized_test_table (id serial)`),
      (err) => {
        assert.equal(err.code, '42501');
        assert.match(err.message, /permission denied/i);
        return true;
      }
    );
  });

  it('DROP TABLE users fails', async () => {
    await assert.rejects(
      () => pool.query(`DROP TABLE users`),
      (err) => {
        assert.match(err.message, /must be owner/i);
        return true;
      }
    );
  });

  it('SELECT on schema_migrations fails with SQLSTATE 42501', async () => {
    await assert.rejects(
      () => pool.query(`SELECT * FROM schema_migrations`),
      (err) => {
        assert.equal(err.code, '42501');
        assert.match(err.message, /permission denied/i);
        return true;
      }
    );
  });

  it('INSERT into events succeeds for app role', async () => {
    const res = await pool.query(
      `INSERT INTO events (tenancy_id, actor_type, actor_label, type, payload)
       VALUES ($1, 'tenant', 'Role Tester', 'app_role_event', '{"ok":true}'::jsonb)
       RETURNING id, type`,
      [tenancyId]
    );
    assert.ok(res.rows[0].id);
    assert.equal(res.rows[0].type, 'app_role_event');
  });

  it('pg_roles shows the app role with rolsuper, rolcreatedb, rolcreaterole, rolbypassrls all false', async () => {
    const res = await pool.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`
    );
    assert.equal(res.rowCount, 1);
    const role = res.rows[0];
    assert.equal(role.rolsuper, false, 'rolsuper must be false');
    assert.equal(role.rolcreatedb, false, 'rolcreatedb must be false');
    assert.equal(role.rolcreaterole, false, 'rolcreaterole must be false');
    assert.equal(role.rolbypassrls, false, 'rolbypassrls must be false');
  });
});
