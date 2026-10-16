import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pool, ensureTestDb } from '../helpers/db.js';

describe('Database Triggers and Invariants', () => {
  let userId;
  let tenancyId;
  let inspectionId;
  let eventId;

  before(async () => {
    await ensureTestDb();

    // Create isolated user, tenancy, inspection, and event for trigger tests
    userId = crypto.randomUUID();
    tenancyId = crypto.randomUUID();
    inspectionId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Trigger Tester', $2, 'hash')`,
      [userId, `trigger_${Date.now()}@example.com`]
    );

    await pool.query(
      `INSERT INTO tenancies (id, tenant_id, property_label, deposit_paise)
       VALUES ($1, $2, 'Trigger Flat', 5000000)`,
      [tenancyId, userId]
    );

    await pool.query(
      `INSERT INTO inspections (id, tenancy_id, type, status)
       VALUES ($1, $2, 'move_in', 'draft')`,
      [inspectionId, tenancyId]
    );

    const evRes = await pool.query(
      `INSERT INTO events (tenancy_id, actor_type, actor_label, type, payload)
       VALUES ($1, 'tenant', 'Trigger Tester', 'test_event', '{}'::jsonb)
       RETURNING id`,
      [tenancyId]
    );
    eventId = evRes.rows[0].id;
  });

  after(async () => {
    await pool.end();
  });

  it('UPDATE on events table fails with "events are append-only"', async () => {
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE events SET actor_label = 'Hacked' WHERE id = $1`,
        [eventId]
      );
    }, /events are append-only/i);
  });

  it('DELETE on events table fails with "events are append-only"', async () => {
    await assert.rejects(async () => {
      await pool.query(`DELETE FROM events WHERE id = $1`, [eventId]);
    }, /events are append-only/i);
  });

  it('TRUNCATE on events table fails with "events are append-only"', async () => {
    await assert.rejects(async () => {
      await pool.query(`TRUNCATE events`);
    }, /events are append-only/i);
  });

  it('changing inspection type fails because type is immutable', async () => {
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspections SET type = 'move_out' WHERE id = $1`,
        [inspectionId]
      );
    }, /inspections type and tenancy_id are immutable/i);
  });

  it('changing inspection tenancy_id fails because tenancy_id is immutable', async () => {
    const anotherTenancyId = crypto.randomUUID();
    await assert.rejects(async () => {
      await pool.query(`UPDATE inspections SET tenancy_id = $1 WHERE id = $2`, [
        anotherTenancyId,
        inspectionId,
      ]);
    }, /inspections type and tenancy_id are immutable/i);
  });

  it('illegal inspection transition draft -> acknowledged fails', async () => {
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspections SET status = 'acknowledged' WHERE id = $1`,
        [inspectionId]
      );
    }, /illegal inspection status transition from draft to acknowledged/i);
  });

  it('legal transitions draft -> submitted -> draft succeed', async () => {
    // 1. draft -> submitted
    const subRes = await pool.query(
      `UPDATE inspections SET status = 'submitted' WHERE id = $1 RETURNING status`,
      [inspectionId]
    );
    assert.equal(subRes.rows[0].status, 'submitted');

    // 2. submitted -> draft (change requested)
    const draftRes = await pool.query(
      `UPDATE inspections SET status = 'draft' WHERE id = $1 RETURNING status`,
      [inspectionId]
    );
    assert.equal(draftRes.rows[0].status, 'draft');

    // 3. no-op update (draft -> draft) succeeds
    const sameRes = await pool.query(
      `UPDATE inspections SET status = 'draft' WHERE id = $1 RETURNING status`,
      [inspectionId]
    );
    assert.equal(sameRes.rows[0].status, 'draft');
  });

  it('transition from acknowledged to draft fails (acknowledged is terminal)', async () => {
    const terminalId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inspections (id, tenancy_id, type, status)
       VALUES ($1, $2, 'move_out', 'draft')`,
      [terminalId, tenancyId]
    );

    // draft -> submitted -> acknowledged
    await pool.query(
      `UPDATE inspections SET status = 'submitted' WHERE id = $1`,
      [terminalId]
    );
    await pool.query(
      `UPDATE inspections SET status = 'acknowledged' WHERE id = $1`,
      [terminalId]
    );

    // acknowledged -> draft must fail
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspections SET status = 'draft' WHERE id = $1`,
        [terminalId]
      );
    }, /inspection is acknowledged and cannot be modified/i);
  });

  it('acknowledged inspection: UPDATE of any column (including acknowledged_by_name) fails', async () => {
    const ackTenancyId = crypto.randomUUID();
    const ackId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tenancies (id, tenant_id, property_label, deposit_paise)
       VALUES ($1, $2, 'Ack Flat', 2000000)`,
      [ackTenancyId, userId]
    );
    await pool.query(
      `INSERT INTO inspections (id, tenancy_id, type, status)
       VALUES ($1, $2, 'move_in', 'draft')`,
      [ackId, ackTenancyId]
    );
    await pool.query(
      `UPDATE inspections SET status = 'submitted' WHERE id = $1`,
      [ackId]
    );
    await pool.query(
      `UPDATE inspections SET status = 'acknowledged' WHERE id = $1`,
      [ackId]
    );

    // Updating any column on acknowledged inspection must fail
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspections SET acknowledged_by_name = 'Landlord Bob' WHERE id = $1`,
        [ackId]
      );
    }, /inspection is acknowledged and cannot be modified/i);
  });

  it('raw SQL insert, update, and delete on items fail when inspection is not in draft status with "LOCKED:" message', async () => {
    // 1. In draft status: insert item succeeds
    const itemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inspection_items (id, inspection_id, room, name, condition)
       VALUES ($1, $2, 'Living room', 'Sofa', 'good')`,
      [itemId, inspectionId]
    );

    // Set inspection to submitted
    await pool.query(
      `UPDATE inspections SET status = 'submitted' WHERE id = $1`,
      [inspectionId]
    );

    // INSERT fails with LOCKED:
    const newItemId = crypto.randomUUID();
    await assert.rejects(async () => {
      await pool.query(
        `INSERT INTO inspection_items (id, inspection_id, room, name, condition)
         VALUES ($1, $2, 'Living room', 'Lamp', 'good')`,
        [newItemId, inspectionId]
      );
    }, /LOCKED: parent inspection is not in draft status/);

    // UPDATE fails with LOCKED:
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspection_items SET note = 'Tried to edit' WHERE id = $1`,
        [itemId]
      );
    }, /LOCKED: parent inspection is not in draft status/);

    // DELETE fails with LOCKED:
    await assert.rejects(async () => {
      await pool.query(`DELETE FROM inspection_items WHERE id = $1`, [itemId]);
    }, /LOCKED: parent inspection is not in draft status/);

    // Restore inspection to draft
    await pool.query(`UPDATE inspections SET status = 'draft' WHERE id = $1`, [
      inspectionId,
    ]);
  });

  it('moving an item to another inspection fails with "LOCKED:"', async () => {
    const otherInspectionId = crypto.randomUUID();
    const otherTenancyId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tenancies (id, tenant_id, property_label, deposit_paise)
       VALUES ($1, $2, 'Other Flat', 3000000)`,
      [otherTenancyId, userId]
    );
    await pool.query(
      `INSERT INTO inspections (id, tenancy_id, type, status)
       VALUES ($1, $2, 'move_in', 'draft')`,
      [otherInspectionId, otherTenancyId]
    );

    const testItemId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO inspection_items (id, inspection_id, room, name, condition)
       VALUES ($1, $2, 'Hall', 'Mirror', 'good')`,
      [testItemId, inspectionId]
    );

    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspection_items SET inspection_id = $1 WHERE id = $2`,
        [otherInspectionId, testItemId]
      );
    }, /LOCKED: inspection items cannot be moved between inspections/);
  });

  it('concurrency: uncommitted status update on connection A blocks item insert on connection B until commit, then B fails with LOCKED:', async () => {
    const concTenancyId = crypto.randomUUID();
    const testInspectionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO tenancies (id, tenant_id, property_label, deposit_paise)
       VALUES ($1, $2, 'Conc Flat', 1500000)`,
      [concTenancyId, userId]
    );
    await pool.query(
      `INSERT INTO inspections (id, tenancy_id, type, status)
       VALUES ($1, $2, 'move_in', 'draft')`,
      [testInspectionId, concTenancyId]
    );

    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
      // 1. Connection A starts transaction and updates inspection to submitted (uncommitted)
      await clientA.query('BEGIN');
      await clientA.query(
        `UPDATE inspections SET status = 'submitted' WHERE id = $1`,
        [testInspectionId]
      );

      // 2. Connection B attempts to insert an item into testInspectionId
      let clientBResolved = false;
      let clientBError = null;

      const clientBPromise = (async () => {
        try {
          await clientB.query(
            `INSERT INTO inspection_items (id, inspection_id, room, name, condition)
             VALUES ($1, $2, 'Balcony', 'Planter', 'good')`,
            [crypto.randomUUID(), testInspectionId]
          );
        } catch (err) {
          clientBError = err;
        } finally {
          clientBResolved = true;
        }
      })();

      // Assert Connection B is blocked waiting for Connection A's lock
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        clientBResolved,
        false,
        'Connection B should be blocked waiting for row lock on inspections'
      );

      // 3. Connection A commits
      await clientA.query('COMMIT');

      // 4. Connection B unblocks, sees submitted status, and fails with LOCKED
      await clientBPromise;
      assert.equal(clientBResolved, true);
      assert.ok(
        clientBError,
        'Connection B should have encountered an error after unblocking'
      );
      assert.match(
        clientBError.message,
        /LOCKED: parent inspection is not in draft status/
      );
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});
