import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSeed } from '../../scripts/seed-demo.js';
import { ensureTestDb, ownerPool, pool } from '../helpers/db.js';
import { LocalStorage } from '../../src/lib/storage/local.js';

describe('Demo Seed Integration Test', () => {
  let tmpUploadDir;
  let customStorage;
  const testPassword = 'DemoTestPassword123!';

  before(async () => {
    await ensureTestDb();
    tmpUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
    customStorage = new LocalStorage(tmpUploadDir);
  });

  after(async () => {
    if (tmpUploadDir && fs.existsSync(tmpUploadDir)) {
      fs.rmSync(tmpUploadDir, { recursive: true, force: true });
    }
  });

  it('runs seed and asserts tenancy statuses, deductions, and photos', async () => {
    // Check if user already exists
    const check = await runSeed({
      password: testPassword,
      add: false,
      pool,
      storage: customStorage,
      closePool: false,
    });

    let result;
    if (check.alreadyExists) {
      assert.equal(check.alreadyExists, true);
      assert.equal(check.email, 'demo@handover.local');

      // Seed with add: true
      result = await runSeed({
        password: testPassword,
        add: true,
        pool,
        storage: customStorage,
        closePool: false,
      });
      assert.equal(result.alreadyExists, false);
    } else {
      result = check;
      assert.equal(result.alreadyExists, false);
    }

    assert.equal(result.email, 'demo@handover.local');
    assert.ok(result.tenancyAId);
    assert.ok(result.tenancyBId);

    // Assert Tenancy A status in DB is settling
    const tenARes = await ownerPool.query(
      `SELECT id, status, property_label, landlord_name, deposit_paise, refund_window_days
       FROM tenancies WHERE id = $1`,
      [result.tenancyAId]
    );
    assert.equal(tenARes.rowCount, 1);
    assert.equal(tenARes.rows[0].status, 'settling');
    assert.equal(tenARes.rows[0].landlord_name, 'Demo Landlord');
    assert.equal(tenARes.rows[0].deposit_paise, 6000000);
    assert.equal(tenARes.rows[0].refund_window_days, 15);

    // Assert Tenancy B status in DB is active
    const tenBRes = await ownerPool.query(
      `SELECT id, status, property_label, landlord_name
       FROM tenancies WHERE id = $1`,
      [result.tenancyBId]
    );
    assert.equal(tenBRes.rowCount, 1);
    assert.equal(tenBRes.rows[0].status, 'active');

    // Assert deduction lines for Tenancy A: 1 accepted, 1 disputed, 1 proposed
    const deductionsRes = await ownerPool.query(
      `SELECT status, count(*)::int AS count
       FROM deduction_lines
       WHERE tenancy_id = $1
       GROUP BY status
       ORDER BY status ASC`,
      [result.tenancyAId]
    );

    const countsByStatus = {};
    for (const row of deductionsRes.rows) {
      countsByStatus[row.status] = row.count;
    }
    assert.equal(countsByStatus.accepted, 1);
    assert.equal(countsByStatus.disputed, 1);
    assert.equal(countsByStatus.proposed, 1);

    // Assert photos uploaded
    const photosRes = await ownerPool.query(
      `SELECT count(*)::int AS count
       FROM media m
       JOIN inspection_items item ON item.id = m.item_id
       JOIN inspections i ON i.id = item.inspection_id
       WHERE i.tenancy_id IN ($1, $2)`,
      [result.tenancyAId, result.tenancyBId]
    );
    assert.ok(photosRes.rows[0].count >= 5);
  });

  it('second run without --add returns alreadyExists: true', async () => {
    const secondRun = await runSeed({
      password: testPassword,
      add: false,
      pool,
      storage: customStorage,
      closePool: false,
    });

    assert.equal(secondRun.alreadyExists, true);
    assert.equal(secondRun.email, 'demo@handover.local');
  });
});
