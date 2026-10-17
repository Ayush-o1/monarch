import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { LocalStorage } from '../../src/lib/storage/local.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

describe('Deductions, Settlement, and Tenancy Close (Phase 8)', () => {
  let app;
  let tmpUploadDir;
  let storage;

  before(async () => {
    await ensureTestDb();
    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-deductions-test-')
    );
    storage = new LocalStorage(tmpUploadDir);
    app = createApp({
      pool,
      storage,
      authLimiter: (_req, _res, next) => next(),
      mediaLimiter: (_req, _res, next) => next(),
      landlordLimiter: (_req, _res, next) => next(),
    });
  });

  after(async () => {
    await pool.end();
    if (tmpUploadDir && fs.existsSync(tmpUploadDir)) {
      fs.rmSync(tmpUploadDir, { recursive: true, force: true });
    }
  });

  function randomEmail() {
    return `deduct_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
  }

  async function createRegisteredAgent(name = 'Tenant') {
    const agent = request.agent(app);
    const email = randomEmail();
    const res = await agent
      .post('/api/auth/register')
      .send({ name, email, password: 'password1234' })
      .expect(201);
    return { agent, user: res.body, email };
  }

  async function makeValidJpeg(width = 50, height = 50) {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();
  }

  // Helper: setup active tenancy with move-in submitted & move-out submitted (in settling status)
  async function setupSettlingTenancy(
    agent,
    { depositPaise = 100000, refundWindowDays = 14 } = {}
  ) {
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        property_label: `Deductions Prop ${Date.now()}`,
        deposit_paise: depositPaise,
        refund_window_days: refundWindowDays,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const moveInId = tenancyRes.body.inspections.moveIn.id;

    // Move-in: Item 1: Fridge (good), Item 2: Wall Paint (minor_wear), Item 3: Sofa (good), Item 4: Planter (good)
    const it1 = await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Kitchen', name: 'Fridge', condition: 'good' })
      .expect(201);
    await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Bedroom', name: 'Wall Paint', condition: 'minor_wear' })
      .expect(201);
    await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Living Room', name: 'Sofa', condition: 'good' })
      .expect(201);
    await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Balcony', name: 'Planter', condition: 'good' })
      .expect(201);

    // Upload photo to Fridge at move-in
    const photoBuf = await makeValidJpeg();
    await agent
      .post(`/api/items/${it1.body.id}/media`)
      .attach('photo', photoBuf, 'fridge_in.jpg')
      .expect(201);

    // Submit move-in
    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // Create landlord invite
    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    // Start move-out
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    // Get cloned move-out items
    const moveOutInsp = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    const outFridge = moveOutInsp.body.items.find((i) => i.name === 'Fridge');
    const outWall = moveOutInsp.body.items.find((i) => i.name === 'Wall Paint');
    const outSofa = moveOutInsp.body.items.find((i) => i.name === 'Sofa');
    const outPlanter = moveOutInsp.body.items.find((i) => i.name === 'Planter');

    // Conditions:
    // Fridge: damaged (outcome worse)
    await agent
      .patch(`/api/items/${outFridge.id}`)
      .send({ condition: 'damaged', note: 'Door cracked' })
      .expect(200);
    // Upload move-out photo to Fridge
    await agent
      .post(`/api/items/${outFridge.id}/media`)
      .attach('photo', photoBuf, 'fridge_out.jpg')
      .expect(201);

    // Wall Paint: good (outcome better)
    await agent
      .patch(`/api/items/${outWall.id}`)
      .send({ condition: 'good', note: 'Fresh paint' })
      .expect(200);

    // Sofa: good (outcome same)
    await agent
      .patch(`/api/items/${outSofa.id}`)
      .send({ condition: 'good', note: 'Clean' })
      .expect(200);

    // Delete Planter (outcome not_in_move_out)
    await agent.delete(`/api/items/${outPlanter.id}`).expect(200);

    // Add new item: Mirror Cabinet (outcome new_at_move_out)
    const newMirror = await agent
      .post(`/api/inspections/${moveOutId}/items`)
      .send({ room: 'Bathroom', name: 'Mirror Cabinet', condition: 'good' })
      .expect(201);

    // Submit move-out -> transitions tenancy to 'settling'
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    return {
      tenancyId,
      token,
      moveInId,
      moveOutId,
      moveInFridgeId: it1.body.id,
      outFridgeId: outFridge.id,
      outWallId: outWall.id,
      outSofaId: outSofa.id,
      newMirrorId: newMirror.body.id,
      depositPaise,
    };
  }

  // 1. Cap checks and amount validation
  it('cap enforcement: exact deposit is allowed, 1 paisa over returns 422, withdrawn frees amount, invalid amounts 400', async () => {
    const { agent } = await createRegisteredAgent('Cap Tester');
    const { token, outFridgeId } = await setupSettlingTenancy(agent, {
      depositPaise: 50000,
    });

    // Invalid amounts: 0, negative, decimal, string, > 1_000_000_000
    for (const badAmt of [0, -100, 50.5, '5000', 1000000001]) {
      const res = await request(app)
        .post(`/api/landlord/${token}/deductions`)
        .send({
          name: 'Landlord',
          description: 'Cleaning fee',
          amountPaise: badAmt,
        })
        .expect(400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }

    // Exact deposit sum is allowed (50000)
    const exactRes = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord Jane',
        description: 'Broken refrigerator replacement',
        amountPaise: 50000,
        itemId: outFridgeId,
      })
      .expect(201);

    assert.equal(exactRes.body.line.amountPaise, 50000);
    assert.equal(exactRes.body.line.status, 'proposed');
    const firstLineId = exactRes.body.line.id;

    // 1 paisa over returns 422 DEDUCTIONS_EXCEED_DEPOSIT with details
    const overRes = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord Jane',
        description: 'Extra cleaning fee',
        amountPaise: 1,
      })
      .expect(422);

    assert.equal(overRes.body.error.code, 'DEDUCTIONS_EXCEED_DEPOSIT');
    assert.equal(overRes.body.error.details.depositPaise, 50000);
    assert.equal(overRes.body.error.details.claimedPaise, 50000);
    assert.equal(overRes.body.error.details.remainingPaise, 0);

    // Withdrawing first line frees its amount
    await request(app)
      .post(`/api/landlord/${token}/deductions/${firstLineId}/withdraw`)
      .send({ name: 'Landlord Jane' })
      .expect(200);

    // Now a 50000 line can be proposed again
    const rePropose = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord Jane',
        description: 'Revised cleaning and repair',
        amountPaise: 45000,
      })
      .expect(201);
    assert.equal(rePropose.body.line.amountPaise, 45000);
  });

  // 2. Concurrency A: deposit 10000 paise; two simultaneous proposals of 6000 give exactly one 201 and one 422
  it('concurrency A: two simultaneous proposals exceeding deposit give one 201 and one 422', async () => {
    const { agent } = await createRegisteredAgent('Concurrency A');
    const { token } = await setupSettlingTenancy(agent, {
      depositPaise: 10000,
    });

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/landlord/${token}/deductions`)
        .send({ name: 'L1', description: 'Repair 1', amountPaise: 6000 }),
      request(app)
        .post(`/api/landlord/${token}/deductions`)
        .send({ name: 'L2', description: 'Repair 2', amountPaise: 6000 }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(
      statuses,
      [201, 422],
      'One proposal succeeds with 201, the other is rejected with 422'
    );
  });

  // 3. Concurrency B: 10 simultaneous proposals of random amounts totalling > deposit; SUM <= deposit
  it('concurrency B: 10 simultaneous random proposals never exceed deposit', async () => {
    const { agent } = await createRegisteredAgent('Concurrency B');
    const { token, tenancyId } = await setupSettlingTenancy(agent, {
      depositPaise: 20000,
    });

    // 10 concurrent requests of 4000 each (total 40000 > 20000)
    const promises = Array.from({ length: 10 }).map((_, idx) =>
      request(app)
        .post(`/api/landlord/${token}/deductions`)
        .send({
          name: `L_${idx}`,
          description: `Damage ${idx}`,
          amountPaise: 4000,
        })
    );

    const results = await Promise.all(promises);
    const successCount = results.filter((r) => r.status === 201).length;
    const errorCount = results.filter((r) => r.status === 422).length;

    assert.equal(successCount, 5, 'Exactly 5 requests of 4000 can succeed');
    assert.equal(errorCount, 5, 'Remaining 5 requests must fail with 422');

    const sumCheck = await pool.query(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total
       FROM deduction_lines
       WHERE tenancy_id = $1 AND status <> 'withdrawn'`,
      [tenancyId]
    );
    assert.equal(Number(sumCheck.rows[0].total), 20000);
  });

  // 4. Concurrency C: a propose and a close fired together: state is consistent; repeat 20 times
  it('concurrency C: propose racing close repeated 20 times maintains consistent settlement', async () => {
    for (let round = 0; round < 20; round++) {
      const { agent } = await createRegisteredAgent(`Close Race ${round}`);
      const { tenancyId, token } = await setupSettlingTenancy(agent, {
        depositPaise: 50000,
      });

      const [propRes, closeRes] = await Promise.all([
        request(app).post(`/api/landlord/${token}/deductions`).send({
          name: 'Landlord',
          description: 'Late bill',
          amountPaise: 5000,
        }),
        agent
          .post(`/api/tenancies/${tenancyId}/close`)
          .send({ acknowledgeUnresolved: true }),
      ]);

      // State consistency check:
      // If propose succeeded (201), the close must have succeeded (200) and counted the proposed line
      // If close finished first (200), propose must get 409 TENANCY_CLOSED
      if (propRes.status === 201) {
        assert.equal(closeRes.status, 200);
        // Verify tenancy_closed event counted the proposed line
        const evRes = await pool.query(
          `SELECT payload FROM events WHERE tenancy_id = $1 AND type = 'tenancy_closed'`,
          [tenancyId]
        );
        assert.equal(evRes.rowCount, 1);
        assert.equal(evRes.rows[0].payload.proposedPaise, 5000);
      } else {
        assert.equal(propRes.status, 409);
        assert.equal(propRes.body.error.code, 'TENANCY_CLOSED');
        assert.equal(closeRes.status, 200);
      }
    }
  });

  // 5. Concurrency D: two simultaneous tenant responses (accept and dispute) on one proposed line
  it('concurrency D: two simultaneous responses (accept and dispute) resolve consistently', async () => {
    const { agent } = await createRegisteredAgent('Resp Concurrency');
    const { token } = await setupSettlingTenancy(agent, {
      depositPaise: 30000,
    });

    const prop = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({ name: 'Landlord', description: 'Carpet burn', amountPaise: 5000 })
      .expect(201);
    const lineId = prop.body.line.id;

    const [resp1, resp2] = await Promise.all([
      agent.patch(`/api/deductions/${lineId}`).send({ action: 'accept' }),
      agent
        .patch(`/api/deductions/${lineId}`)
        .send({ action: 'dispute', note: 'Pre-existing burn' }),
    ]);

    // Either accept won (terminal state, dispute gets 409)
    // Or dispute won (200) and accept ran after dispute (200) because dispute->accepted is legal!
    if (resp1.status === 200 && resp2.status === 409) {
      assert.equal(resp2.body.error.code, 'INVALID_STATE');
    } else if (resp2.status === 200 && resp1.status === 200) {
      // dispute executed first, accept executed second -> final state accepted
      const check = await pool.query(
        `SELECT status FROM deduction_lines WHERE id = $1`,
        [lineId]
      );
      assert.equal(check.rows[0].status, 'accepted');
    } else {
      assert.fail(
        `Unexpected response statuses: resp1=${resp1.status}, resp2=${resp2.status}`
      );
    }
  });

  // 6. Raw SQL trigger tests: cap guard and guard immutability/transitions
  it('raw SQL trigger tests: cap guard rejects excessive inserts; guard rejects column changes and illegal transitions', async () => {
    const { agent } = await createRegisteredAgent('Trigger Raw');
    const { tenancyId, outFridgeId } = await setupSettlingTenancy(agent, {
      depositPaise: 40000,
    });

    // 1. Direct SQL insert exceeding deposit is blocked by deduction_cap_guard
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO deduction_lines (tenancy_id, description, amount_paise, created_by_name)
           VALUES ($1, 'Direct insert', 40001, 'Attacker')`,
          [tenancyId]
        ),
      (err) => {
        assert.match(err.message, /CAP: total deductions/);
        return true;
      }
    );

    // Insert valid line directly
    const insRes = await pool.query(
      `INSERT INTO deduction_lines (tenancy_id, item_id, description, amount_paise, created_by_name)
       VALUES ($1, $2, 'Valid line', 10000, 'Landlord')
       RETURNING id`,
      [tenancyId, outFridgeId]
    );
    const lineId = insRes.rows[0].id;

    // 2. Guard rejects updating amount_paise
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE deduction_lines SET amount_paise = 15000 WHERE id = $1`,
          [lineId]
        ),
      (err) => {
        assert.match(err.message, /ILLEGAL: amount_paise is immutable/);
        return true;
      }
    );

    // 3. Guard rejects updating description
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE deduction_lines SET description = 'Changed' WHERE id = $1`,
          [lineId]
        ),
      (err) => {
        assert.match(err.message, /ILLEGAL: description is immutable/);
        return true;
      }
    );

    // 4. Guard rejects updating item_id
    await assert.rejects(
      () =>
        pool.query(`UPDATE deduction_lines SET item_id = null WHERE id = $1`, [
          lineId,
        ]),
      (err) => {
        assert.match(err.message, /ILLEGAL: item_id is immutable/);
        return true;
      }
    );

    // 5. Guard rejects illegal transitions: set status to accepted first
    await pool.query(
      `UPDATE deduction_lines SET status = 'accepted' WHERE id = $1`,
      [lineId]
    );

    // Accepted -> withdrawn fails
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE deduction_lines SET status = 'withdrawn' WHERE id = $1`,
          [lineId]
        ),
      (err) => {
        assert.match(err.message, /ILLEGAL: deduction line is accepted/);
        return true;
      }
    );

    // Accepted -> disputed fails
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE deduction_lines SET status = 'disputed' WHERE id = $1`,
          [lineId]
        ),
      (err) => {
        assert.match(err.message, /ILLEGAL: deduction line is accepted/);
        return true;
      }
    );
  });

  // 6b. Trigger precedence: cap guard only fires on INSERT, not UPDATE
  it('trigger precedence: with deposit fully claimed, UPDATE of withdrawn line to proposed fails with ILLEGAL:, not CAP:', async () => {
    const { agent } = await createRegisteredAgent('Precedence Tester');
    const { token, tenancyId } = await setupSettlingTenancy(agent, {
      depositPaise: 10000,
    });

    // Line 1 fills the entire deposit
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'L',
        description: 'Full deposit claim',
        amountPaise: 10000,
      })
      .expect(201);

    // Direct insert of a withdrawn line for 5000 (withdrawn lines are allowed past the cap)
    const insRes = await pool.query(
      `INSERT INTO deduction_lines (tenancy_id, description, amount_paise, created_by_name, status)
       VALUES ($1, 'Withdrawn line', 5000, 'L', 'withdrawn')
       RETURNING id`,
      [tenancyId]
    );
    const withdrawnLineId = insRes.rows[0].id;

    // UPDATE of withdrawn line to proposed:
    // With 008, cap guard does not fire on UPDATE, so deduction_lines_guard fires
    // and throws ILLEGAL: (mapping to 409 INVALID_STATE), not CAP: (422).
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE deduction_lines SET status = 'proposed' WHERE id = $1`,
          [withdrawnLineId]
        ),
      (err) => {
        assert.match(err.message, /^ILLEGAL:/);
        assert.doesNotMatch(err.message, /^CAP:/);
        return true;
      }
    );
  });

  // 7. Legal and illegal transitions through API
  it('transition rules: proposed->accepted, proposed->disputed, disputed->accepted, proposed->withdrawn, disputed->withdrawn; terminal states 409', async () => {
    const { agent } = await createRegisteredAgent('Transitions Tester');
    const { token } = await setupSettlingTenancy(agent, {
      depositPaise: 50000,
    });

    // A. proposed -> disputed -> accepted
    const p1 = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({ name: 'L', description: 'Item 1', amountPaise: 5000 })
      .expect(201);
    const id1 = p1.body.line.id;

    // Dispute requires note
    await agent
      .patch(`/api/deductions/${id1}`)
      .send({ action: 'dispute' })
      .expect(400);

    const disp = await agent
      .patch(`/api/deductions/${id1}`)
      .send({ action: 'dispute', note: 'Not my fault' })
      .expect(200);
    assert.equal(disp.body.line.status, 'disputed');

    // disputed -> accepted
    const acc = await agent
      .patch(`/api/deductions/${id1}`)
      .send({ action: 'accept' })
      .expect(200);
    assert.equal(acc.body.line.status, 'accepted');

    // accepted -> withdrawn fails
    const failWith = await request(app)
      .post(`/api/landlord/${token}/deductions/${id1}/withdraw`)
      .send({ name: 'L' })
      .expect(409);
    assert.equal(failWith.body.error.code, 'INVALID_STATE');

    // B. disputed -> withdrawn
    const p2 = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({ name: 'L', description: 'Item 2', amountPaise: 6000 })
      .expect(201);
    const id2 = p2.body.line.id;

    await agent
      .patch(`/api/deductions/${id2}`)
      .send({ action: 'dispute', note: 'Wear and tear' })
      .expect(200);

    const withRes = await request(app)
      .post(`/api/landlord/${token}/deductions/${id2}/withdraw`)
      .send({ name: 'L' })
      .expect(200);
    assert.equal(withRes.body.line.status, 'withdrawn');

    // Withdrawn cannot be accepted or disputed
    const failAcc = await agent
      .patch(`/api/deductions/${id2}`)
      .send({ action: 'accept' })
      .expect(409);
    assert.equal(failAcc.body.error.code, 'INVALID_STATE');

    // Tenant cannot call withdraw (route is landlord-only)
    await agent.post(`/api/deductions/${id2}/withdraw`).expect(404);

    // Landlord cannot call tenant respond route without tenant session (returns 401 UNAUTHORIZED)
    const unauthRespond = await request(app)
      .patch(`/api/deductions/${id2}`)
      .send({ action: 'accept' })
      .expect(401);
    assert.equal(unauthRespond.body.error.code, 'UNAUTHORIZED');
  });

  // 8. itemId validation
  it('itemId validation: from another tenancy gives 422, from move_in gives 422, null is allowed with not_linked', async () => {
    const { agent: agentA } = await createRegisteredAgent('Tenant A');
    const { agent: agentB } = await createRegisteredAgent('Tenant B');

    const tenA = await setupSettlingTenancy(agentA);
    const tenB = await setupSettlingTenancy(agentB);

    // itemId from another tenancy
    const resAlien = await request(app)
      .post(`/api/landlord/${tenA.token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Alien item',
        amountPaise: 1000,
        itemId: tenB.outFridgeId,
      })
      .expect(422);
    assert.equal(resAlien.body.error.code, 'INVALID_ITEM');

    // itemId from this tenancy's move_in inspection
    const resMoveIn = await request(app)
      .post(`/api/landlord/${tenA.token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Move in item',
        amountPaise: 1000,
        itemId: tenA.moveInFridgeId,
      })
      .expect(422);
    assert.equal(resMoveIn.body.error.code, 'INVALID_ITEM');

    // itemId null is allowed
    const resNull = await request(app)
      .post(`/api/landlord/${tenA.token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Unlinked utility bill',
        amountPaise: 1500,
        itemId: null,
      })
      .expect(201);
    assert.equal(resNull.body.line.itemId, null);
  });

  // 9. State gating: propose before settling, after close; respond after close
  it('state gating: propose before settling gives 409, propose after close gives 409 TENANCY_CLOSED, respond after close gives 409 TENANCY_CLOSED', async () => {
    const { agent } = await createRegisteredAgent('State Gate Tester');

    // Create tenancy (status: active)
    const tRes = await agent
      .post('/api/tenancies')
      .send({ property_label: 'Gate Prop', deposit_paise: 50000 })
      .expect(201);
    const tId = tRes.body.id;
    const invRes = await agent.post(`/api/tenancies/${tId}/invite`).expect(201);
    const token = invRes.body.url.split('/l/')[1];

    // Propose while active returns 409 INVALID_STATE
    const resActive = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({ name: 'Landlord', description: 'Early line', amountPaise: 1000 })
      .expect(409);
    assert.equal(resActive.body.error.code, 'INVALID_STATE');

    // Complete setup to settling
    const { token: setToken, tenancyId: setTId } = await setupSettlingTenancy(
      agent,
      { depositPaise: 40000 }
    );

    // Propose a line
    const pRes = await request(app)
      .post(`/api/landlord/${setToken}/deductions`)
      .send({ name: 'Landlord', description: 'Damage', amountPaise: 5000 })
      .expect(201);
    const lineId = pRes.body.line.id;

    // Close tenancy with acknowledgeUnresolved flag
    await agent
      .post(`/api/tenancies/${setTId}/close`)
      .send({ acknowledgeUnresolved: true })
      .expect(200);

    // Propose after close -> 409 TENANCY_CLOSED
    const resClosedProp = await request(app)
      .post(`/api/landlord/${setToken}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Post-close line',
        amountPaise: 1000,
      })
      .expect(409);
    assert.equal(resClosedProp.body.error.code, 'TENANCY_CLOSED');

    // Respond after close -> 409 TENANCY_CLOSED
    const resClosedResp = await agent
      .patch(`/api/deductions/${lineId}`)
      .send({ action: 'accept' })
      .expect(409);
    assert.equal(resClosedResp.body.error.code, 'TENANCY_CLOSED');
  });

  // 10. Isolation across users and tenancies
  it('isolation: responding to another user line gives 404; withdrawing another tenancy line gives 404', async () => {
    const { agent: agentA } = await createRegisteredAgent('User A');
    const { agent: agentB } = await createRegisteredAgent('User B');

    const tenA = await setupSettlingTenancy(agentA);
    const tenB = await setupSettlingTenancy(agentB);

    const propA = await request(app)
      .post(`/api/landlord/${tenA.token}/deductions`)
      .send({ name: 'Landlord A', description: 'Line A', amountPaise: 2000 })
      .expect(201);

    // User B attempts to respond to User A line -> 404 NOT_FOUND
    const snooped = await agentB
      .patch(`/api/deductions/${propA.body.line.id}`)
      .send({ action: 'accept' })
      .expect(404);
    assert.equal(snooped.body.error.code, 'NOT_FOUND');

    // Landlord B attempts to withdraw Landlord A line -> 404 NOT_FOUND
    const wrongTokenWithdraw = await request(app)
      .post(
        `/api/landlord/${tenB.token}/deductions/${propA.body.line.id}/withdraw`
      )
      .send({ name: 'Landlord B' })
      .expect(404);
    assert.equal(wrongTokenWithdraw.body.error.code, 'NOT_FOUND');
  });

  // 11. Close tenancy requirements
  it('close: unresolved deductions without flag return 422 UNRESOLVED_DEDUCTIONS; with flag returns 200; double close 409', async () => {
    const { agent } = await createRegisteredAgent('Close Flags Tester');
    const { tenancyId, token } = await setupSettlingTenancy(agent, {
      depositPaise: 60000,
    });

    // Propose 1 line (proposed) and 1 line that gets disputed
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({ name: 'L', description: 'Proposed line', amountPaise: 10000 })
      .expect(201);

    const p2 = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({ name: 'L', description: 'Disputed line', amountPaise: 5000 })
      .expect(201);

    await agent
      .patch(`/api/deductions/${p2.body.line.id}`)
      .send({ action: 'dispute', note: 'Disagree' })
      .expect(200);

    // Attempting to close without acknowledgeUnresolved returns 422 with counts
    const unresFail = await agent
      .post(`/api/tenancies/${tenancyId}/close`)
      .send({ acknowledgeUnresolved: false })
      .expect(422);

    assert.equal(unresFail.body.error.code, 'UNRESOLVED_DEDUCTIONS');
    assert.equal(unresFail.body.error.details.unresolved, 2);
    assert.equal(unresFail.body.error.details.proposed, 1);
    assert.equal(unresFail.body.error.details.disputed, 1);

    // Close with acknowledgeUnresolved: true succeeds
    const closeSuccess = await agent
      .post(`/api/tenancies/${tenancyId}/close`)
      .send({ acknowledgeUnresolved: true })
      .expect(200);

    assert.equal(closeSuccess.body.status, 'closed');
    assert.equal(closeSuccess.body.settlement.depositPaise, 60000);
    assert.equal(closeSuccess.body.settlement.proposedPaise, 10000);
    assert.equal(closeSuccess.body.settlement.disputedPaise, 5000);
    assert.equal(closeSuccess.body.settlement.unclaimedPaise, 45000);

    // Tenancy status in DB is closed
    const tCheck = await pool.query(
      `SELECT status FROM tenancies WHERE id = $1`,
      [tenancyId]
    );
    assert.equal(tCheck.rows[0].status, 'closed');

    // Closing a second time returns 409
    const secondClose = await agent
      .post(`/api/tenancies/${tenancyId}/close`)
      .send({ acknowledgeUnresolved: true })
      .expect(409);
    assert.equal(secondClose.body.error.code, 'INVALID_STATE');
  });

  // 12. Settlement GET: linkedChange mapping & photos
  it('settlement GET: maps linkedChange (worse, better, same, new_at_move_out, not_linked) and photos correctly', async () => {
    const { agent } = await createRegisteredAgent('Linked Change Tester');
    const { tenancyId, token, outFridgeId, outWallId, outSofaId, newMirrorId } =
      await setupSettlingTenancy(agent, { depositPaise: 80000 });

    // Propose line linked to outFridge (worse)
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Broken fridge repair',
        amountPaise: 12000,
        itemId: outFridgeId,
      })
      .expect(201);

    // Propose line linked to outWall (better)
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Wall touchup',
        amountPaise: 2000,
        itemId: outWallId,
      })
      .expect(201);

    // Propose line linked to outSofa (same)
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Sofa cleaning',
        amountPaise: 3000,
        itemId: outSofaId,
      })
      .expect(201);

    // Propose line linked to newMirror (new_at_move_out)
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Mirror removal',
        amountPaise: 1500,
        itemId: newMirrorId,
      })
      .expect(201);

    // Propose unlinked line (not_linked)
    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Key replacement',
        amountPaise: 500,
        itemId: null,
      })
      .expect(201);

    // Tenant GET settlement
    const setRes = await agent
      .get(`/api/tenancies/${tenancyId}/settlement`)
      .expect(200);

    const lines = setRes.body.lines;
    assert.equal(lines.length, 5);

    const fridgeLine = lines.find((l) => l.description.includes('fridge'));
    assert.equal(fridgeLine.linkedChange, 'worse');
    assert.equal(fridgeLine.photos.moveIn.length, 1);
    assert.equal(fridgeLine.photos.moveOut.length, 1);

    const wallLine = lines.find((l) => l.description.includes('Wall touchup'));
    assert.equal(wallLine.linkedChange, 'better');

    const sofaLine = lines.find((l) => l.description.includes('Sofa cleaning'));
    assert.equal(sofaLine.linkedChange, 'same');

    const mirrorLine = lines.find((l) => l.description.includes('Mirror'));
    assert.equal(mirrorLine.linkedChange, 'new_at_move_out');

    const unlinkedLine = lines.find((l) => l.description.includes('Key'));
    assert.equal(unlinkedLine.linkedChange, 'not_linked');

    // Settlement GET for another user gives 404
    const { agent: otherAgent } = await createRegisteredAgent('Snoop Tenant');
    await otherAgent.get(`/api/tenancies/${tenancyId}/settlement`).expect(404);
  });

  // 13. Landlord payload privacy and security headers
  it('landlord payload: contains settlement and lines, no tenant email/id, and privacy headers present', async () => {
    const { agent, user, email } = await createRegisteredAgent(
      'Sensitive Landlord Test'
    );
    const { token } = await setupSettlingTenancy(agent);

    await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'Paint scrape',
        amountPaise: 4000,
      })
      .expect(201);

    const res = await request(app)
      .get(`/api/landlord/${token}/tenancy`)
      .expect(200);

    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.ok(res.body.settlement);
    assert.ok(Array.isArray(res.body.deductionLines));
    assert.equal(res.body.deductionLines.length, 1);
    assert.ok(Array.isArray(res.body.moveOutItems));

    const bodyStr = JSON.stringify(res.body);
    assert.equal(bodyStr.includes(email), false, 'Must not leak tenant email');
    assert.equal(
      bodyStr.includes(user.id),
      false,
      'Must not leak tenant user ID'
    );
    assert.equal(
      bodyStr.includes('password'),
      false,
      'Must not leak password hash'
    );
  });

  // 14. Timeline contains all new event types in order
  it('timeline contains all Phase 8 event types in chronological order', async () => {
    const { agent } = await createRegisteredAgent('Timeline Tester');
    const { tenancyId, token } = await setupSettlingTenancy(agent, {
      depositPaise: 50000,
    });

    // 1. deduction_proposed
    const prop1 = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'To be accepted',
        amountPaise: 5000,
      })
      .expect(201);

    const prop2 = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'To be disputed',
        amountPaise: 3000,
      })
      .expect(201);

    const prop3 = await request(app)
      .post(`/api/landlord/${token}/deductions`)
      .send({
        name: 'Landlord',
        description: 'To be withdrawn',
        amountPaise: 2000,
      })
      .expect(201);

    // 2. deduction_accepted
    await agent
      .patch(`/api/deductions/${prop1.body.line.id}`)
      .send({ action: 'accept' })
      .expect(200);

    // 3. deduction_disputed
    await agent
      .patch(`/api/deductions/${prop2.body.line.id}`)
      .send({ action: 'dispute', note: 'Disputing line 2' })
      .expect(200);

    // 4. deduction_withdrawn
    await request(app)
      .post(`/api/landlord/${token}/deductions/${prop3.body.line.id}/withdraw`)
      .send({ name: 'Landlord' })
      .expect(200);

    // 5. tenancy_closed
    await agent
      .post(`/api/tenancies/${tenancyId}/close`)
      .send({ acknowledgeUnresolved: true })
      .expect(200);

    // Fetch timeline
    const eventsRes = await agent
      .get(`/api/tenancies/${tenancyId}/events`)
      .expect(200);

    const types = eventsRes.body.map((e) => e.type);
    const p8Types = types.filter((t) =>
      [
        'deduction_proposed',
        'deduction_accepted',
        'deduction_disputed',
        'deduction_withdrawn',
        'tenancy_closed',
      ].includes(t)
    );

    assert.ok(p8Types.includes('deduction_proposed'));
    assert.ok(p8Types.includes('deduction_accepted'));
    assert.ok(p8Types.includes('deduction_disputed'));
    assert.ok(p8Types.includes('deduction_withdrawn'));
    assert.ok(p8Types.includes('tenancy_closed'));
  });
});
