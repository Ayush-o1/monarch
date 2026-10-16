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

describe('Move-out Lifecycle, Comparison Engine, and Landlord Review (Phase 7)', () => {
  let app;
  let tmpUploadDir;
  let storage;

  before(async () => {
    await ensureTestDb();
    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-moveout-test-')
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
    return `moveout_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
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

  async function setupActiveTenancyWithMoveIn(agent) {
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        property_label: `MoveOut Tenancy ${Date.now()}`,
        deposit_paise: 4000000,
        refund_window_days: 14,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const moveInId = tenancyRes.body.inspections.moveIn.id;

    // Add 2 items to move-in
    const item1Res = await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({
        room: 'Kitchen',
        name: 'Refrigerator',
        condition: 'good',
        note: 'Cold and working',
      })
      .expect(201);

    const item2Res = await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({
        room: 'Living Room',
        name: 'Hardwood Floor',
        condition: 'good',
        note: 'Polished',
      })
      .expect(201);

    // Upload a photo to item1
    const imgBuf = await makeValidJpeg();
    const photoRes = await agent
      .post(`/api/items/${item1Res.body.id}/media`)
      .attach('photo', imgBuf, 'fridge.jpg')
      .expect(201);

    return {
      tenancyId,
      moveInId,
      item1Id: item1Res.body.id,
      item2Id: item2Res.body.id,
      photoId: photoRes.body.id,
    };
  }

  it('move-out cannot start before move-in is submitted or acknowledged', async () => {
    const { agent } = await createRegisteredAgent('Early Starter');
    const { tenancyId } = await setupActiveTenancyWithMoveIn(agent);

    // Move-in is still in draft
    const res = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(409);

    assert.equal(res.body.error.code, 'INVALID_STATE');
    assert.match(
      res.body.error.message,
      /must be submitted or acknowledged before starting move-out/i
    );
  });

  it('non-active tenancy cannot start move-out', async () => {
    const { agent } = await createRegisteredAgent('Inactive Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    // Submit move-in
    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // Set tenancy status to closed via SQL
    await pool.query(`UPDATE tenancies SET status = 'closed' WHERE id = $1`, [
      tenancyId,
    ]);

    const res = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(409);

    assert.equal(res.body.error.code, 'INVALID_STATE');
    assert.match(res.body.error.message, /must be active/i);
  });

  it('ownership and not-found handling for starting move-out', async () => {
    const { agent: agentA } = await createRegisteredAgent('User A');
    const { agent: agentB } = await createRegisteredAgent('User B');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agentA);

    await agentA.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // User B tries to start move-out on User A's tenancy
    const resForbidden = await agentB
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(404);
    assert.equal(resForbidden.body.error.code, 'NOT_FOUND');

    // Unknown UUID
    const resUnknown = await agentA
      .post('/api/tenancies/a0000000-0000-0000-0000-000000000000/move-out')
      .expect(404);
    assert.equal(resUnknown.body.error.code, 'NOT_FOUND');

    // Malformed UUID
    const resMalformed = await agentA
      .post('/api/tenancies/not-a-uuid/move-out')
      .expect(404);
    assert.equal(resMalformed.body.error.code, 'NOT_FOUND');
  });

  it('successful creation, item cloning, blank conditions/notes, zero copied photos, and move_out_started event', async () => {
    const { agent } = await createRegisteredAgent('Move-out Starter');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    // Submit move-in
    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // Start move-out
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);

    assert.ok(startRes.body.tenancy);
    assert.equal(startRes.body.tenancy.status, 'move_out');
    assert.ok(startRes.body.inspection);
    assert.equal(startRes.body.inspection.type, 'move_out');
    assert.equal(startRes.body.inspection.status, 'draft');

    const moveOutId = startRes.body.inspection.id;

    // Verify cloned items via GET /api/inspections/:id
    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);

    const items = inspRes.body.items;
    assert.equal(items.length, 2, 'Should have cloned exactly 2 items');

    for (const item of items) {
      assert.equal(
        item.condition,
        null,
        'Cloned item condition must be NULL / blank'
      );
      assert.equal(item.note, null, 'Cloned item note must be NULL / blank');
      assert.equal(
        item.media.length,
        0,
        'Cloned item must have 0 media rows copied'
      );
    }

    // Verify room and name matched move-in
    const fridge = items.find((i) => i.name === 'Refrigerator');
    assert.ok(fridge);
    assert.equal(fridge.room, 'Kitchen');

    const floor = items.find((i) => i.name === 'Hardwood Floor');
    assert.ok(floor);
    assert.equal(floor.room, 'Living Room');

    // Verify photo table has NOT duplicated photo files or media rows
    const mediaCheck = await pool.query(
      `SELECT COUNT(*)::int AS count FROM media WHERE item_id = $1`,
      [fridge.id]
    );
    assert.equal(mediaCheck.rows[0].count, 0);

    // Check events table for move_out_started
    const eventsRes = await agent
      .get(`/api/tenancies/${tenancyId}/events`)
      .expect(200);

    const moveOutEvent = eventsRes.body.find(
      (e) => e.type === 'move_out_started'
    );
    assert.ok(moveOutEvent, 'move_out_started event must be recorded');
    assert.equal(moveOutEvent.actor_type, 'tenant');
    assert.equal(moveOutEvent.payload.inspectionId, moveOutId);
    assert.equal(moveOutEvent.payload.itemCount, 2);
  });

  it('only one move-out inspection may exist; second attempt returns 409', async () => {
    const { agent } = await createRegisteredAgent('One Only');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    await agent.post(`/api/tenancies/${tenancyId}/move-out`).expect(201);

    // Second attempt
    const res = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(409);
    assert.equal(res.body.error.code, 'INVALID_STATE');
  });

  it('concurrent move-out start requests: exactly one succeeds with 201, other gets 409', async () => {
    const { agent } = await createRegisteredAgent('Concurrency Champion');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // Two simultaneous start move-out requests
    const [res1, res2] = await Promise.all([
      agent.post(`/api/tenancies/${tenancyId}/move-out`),
      agent.post(`/api/tenancies/${tenancyId}/move-out`),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(
      statuses,
      [201, 409],
      'Exactly one request should return 201 and one should return 409'
    );

    // Check DB has exactly 1 move-out inspection
    const countRes = await pool.query(
      `SELECT count(*)::int as count FROM inspections WHERE tenancy_id = $1 AND type = 'move_out'`,
      [tenancyId]
    );
    assert.equal(countRes.rows[0].count, 1);
  });

  it('empty move-out submission and incomplete conditions validation', async () => {
    const { agent } = await createRegisteredAgent('Validation Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    // 1. Incomplete conditions (all cloned items are currently blank)
    const incompleteRes = await agent
      .post(`/api/inspections/${moveOutId}/submit`)
      .expect(422);

    assert.equal(incompleteRes.body.error.code, 'INCOMPLETE_ITEMS');
    assert.ok(
      Array.isArray(incompleteRes.body.error.details),
      'Must contain details array'
    );
    assert.equal(incompleteRes.body.error.details.length, 2);

    // Delete both items to test NO_ITEMS
    const insp = await agent.get(`/api/inspections/${moveOutId}`).expect(200);
    for (const item of insp.body.items) {
      await agent.delete(`/api/items/${item.id}`).expect(200);
    }

    const noItemsRes = await agent
      .post(`/api/inspections/${moveOutId}/submit`)
      .expect(422);
    assert.equal(noItemsRes.body.error.code, 'NO_ITEMS');
  });

  it('atomic move-out submission and transition to settling', async () => {
    const { agent } = await createRegisteredAgent('Settling Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    // Assign conditions to both cloned items
    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agent
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'minor_wear', note: 'Slight use' })
        .expect(200);
    }

    // Submit move-out
    const submitRes = await agent
      .post(`/api/inspections/${moveOutId}/submit`)
      .expect(200);

    assert.equal(submitRes.body.inspection.status, 'submitted');
    assert.ok(submitRes.body.inspection.submitted_at);

    // Verify tenancy is now in settling status
    const tenancyRes = await agent
      .get(`/api/tenancies/${tenancyId}`)
      .expect(200);
    assert.equal(tenancyRes.body.status, 'settling');

    // Verify inspection_submitted event
    const eventsRes = await agent
      .get(`/api/tenancies/${tenancyId}/events`)
      .expect(200);
    const submitEvent = eventsRes.body.find(
      (e) => e.type === 'inspection_submitted' && e.payload.type === 'move_out'
    );
    assert.ok(submitEvent);
    assert.equal(submitEvent.payload.itemCount, 2);
  });

  it('concurrent move-out submission: exactly one succeeds, second gets 409 INSPECTION_NOT_DRAFT', async () => {
    const { agent } = await createRegisteredAgent('Concurrent Submit Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    // Fill conditions
    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agent
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }

    // Submit simultaneously
    const [res1, res2] = await Promise.all([
      agent.post(`/api/inspections/${moveOutId}/submit`),
      agent.post(`/api/inspections/${moveOutId}/submit`),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(
      statuses,
      [200, 409],
      'One submission succeeds (200), other fails (409)'
    );
  });

  it('item and media mutations are rejected after move-out submission (API and DB trigger)', async () => {
    const { agent } = await createRegisteredAgent('Mutation Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    const item = inspRes.body.items[0];

    await agent
      .patch(`/api/items/${item.id}`)
      .send({ condition: 'good' })
      .expect(200);
    await agent
      .patch(`/api/items/${inspRes.body.items[1].id}`)
      .send({ condition: 'good' })
      .expect(200);

    // Submit
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    // 1. API POST item
    const postItem = await agent
      .post(`/api/inspections/${moveOutId}/items`)
      .send({ room: 'Hall', name: 'Lamp', condition: 'good' })
      .expect(409);
    assert.equal(postItem.body.error.code, 'INSPECTION_LOCKED');

    // 2. API PATCH item
    const patchItem = await agent
      .patch(`/api/items/${item.id}`)
      .send({ condition: 'damaged' })
      .expect(409);
    assert.equal(patchItem.body.error.code, 'INSPECTION_LOCKED');

    // 3. API DELETE item
    const deleteItem = await agent.delete(`/api/items/${item.id}`).expect(409);
    assert.equal(deleteItem.body.error.code, 'INSPECTION_LOCKED');

    // 4. API upload photo
    const imgBuf = await makeValidJpeg();
    const uploadPhoto = await agent
      .post(`/api/items/${item.id}/media`)
      .attach('photo', imgBuf, 'new.jpg')
      .expect(409);
    assert.equal(uploadPhoto.body.error.code, 'INSPECTION_LOCKED');

    // 5. Raw SQL insert on inspection_items rejected by trigger
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO inspection_items (inspection_id, room, name, condition)
           VALUES ($1, 'Kitchen', 'Toaster', 'good')`,
          [moveOutId]
        ),
      (err) => {
        assert.match(
          err.message,
          /LOCKED: parent inspection is not in draft status/i
        );
        return true;
      }
    );
  });

  it('comparison availability: 409 when draft, 200 when submitted; draft invisible to landlord', async () => {
    const { agent } = await createRegisteredAgent('Comparison Flow');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    // Submit move-in
    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // Generate landlord invite
    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const landlordToken = inviteRes.body.url.split('/l/')[1];

    // Start move-out (draft)
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    // Tenant comparison is unavailable while move-out is draft (409)
    const draftCompRes = await agent
      .get(`/api/tenancies/${tenancyId}/comparison`)
      .expect(409);
    assert.equal(draftCompRes.body.error.code, 'INVALID_STATE');

    // Landlord review page/api only lists move-in; draft move-out is invisible
    const landlordTenancy = await request(app)
      .get(`/api/landlord/${landlordToken}/tenancy`)
      .expect(200);
    assert.equal(landlordTenancy.body.inspections.length, 1);
    assert.equal(landlordTenancy.body.inspections[0].type, 'move_in');

    // Landlord comparison endpoint returns 409 while draft
    const landlordCompDraft = await request(app)
      .get(`/api/landlord/${landlordToken}/comparison`)
      .expect(409);
    assert.equal(landlordCompDraft.body.error.code, 'INVALID_STATE');

    // Set conditions on move-out items:
    // item 1: Refrigerator was 'good', set to 'damaged' -> outcome 'worse'
    // item 2: Hardwood Floor was 'good', set to 'good' -> outcome 'same'
    // Add item 3: Microwave, only at move-out -> outcome 'new_at_move_out'
    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    const fridge = inspRes.body.items.find((i) => i.name === 'Refrigerator');
    const floor = inspRes.body.items.find((i) => i.name === 'Hardwood Floor');

    await agent
      .patch(`/api/items/${fridge.id}`)
      .send({ condition: 'damaged', note: 'Door dented' })
      .expect(200);

    await agent
      .patch(`/api/items/${floor.id}`)
      .send({ condition: 'good', note: 'Still good' })
      .expect(200);

    await agent
      .post(`/api/inspections/${moveOutId}/items`)
      .send({
        room: 'Kitchen',
        name: 'Microwave',
        condition: 'good',
        note: 'Tenant added microwave',
      })
      .expect(201);

    // Submit move-out
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    // Tenant comparison is now 200
    const tenantComp = await agent
      .get(`/api/tenancies/${tenancyId}/comparison`)
      .expect(200);

    assert.ok(tenantComp.body.tenancy);
    assert.equal(tenantComp.body.tenancy.status, 'settling');
    assert.ok(tenantComp.body.comparison);

    const { summary, items } = tenantComp.body.comparison;
    assert.equal(summary.worse, 1);
    assert.equal(summary.same, 1);
    assert.equal(summary.newAtMoveOut, 1);
    assert.equal(summary.notInMoveOut, 0);

    const fridgeComparison = items.find((i) => i.name === 'Refrigerator');
    assert.equal(fridgeComparison.outcome, 'worse');
    assert.equal(fridgeComparison.moveIn.condition, 'good');
    assert.equal(fridgeComparison.moveOut.condition, 'damaged');

    const floorComparison = items.find((i) => i.name === 'Hardwood Floor');
    assert.equal(floorComparison.outcome, 'same');

    const microComparison = items.find((i) => i.name === 'Microwave');
    assert.equal(microComparison.outcome, 'new_at_move_out');
    assert.equal(microComparison.moveIn, null);
    assert.ok(microComparison.moveOut);

    // Landlord comparison endpoint is now 200
    const landlordComp = await request(app)
      .get(`/api/landlord/${landlordToken}/comparison`)
      .expect(200);

    assert.equal(landlordComp.headers['cache-control'], 'no-store');
    assert.equal(landlordComp.headers['referrer-policy'], 'no-referrer');
    assert.equal(landlordComp.body.comparison.summary.worse, 1);
    assert.equal(landlordComp.body.comparison.summary.same, 1);
    assert.equal(landlordComp.body.comparison.summary.newAtMoveOut, 1);

    // Verify Landlord comparison page route serves HTML with required privacy headers
    const landlordHtmlRes = await request(app)
      .get(`/l/${landlordToken}/compare`)
      .expect(200);
    assert.equal(landlordHtmlRes.headers['cache-control'], 'no-store');
    assert.equal(landlordHtmlRes.headers['referrer-policy'], 'no-referrer');
  });

  it('no sensitive tenant data in landlord comparison or tenancy responses', async () => {
    const { agent, user, email } =
      await createRegisteredAgent('Sensitive Tenant');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    // Fill conditions and submit
    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agent
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    const landlordComp = await request(app)
      .get(`/api/landlord/${token}/comparison`)
      .expect(200);

    const bodyStr = JSON.stringify(landlordComp.body);

    // Assert absence of sensitive tenant identifiers
    assert.equal(
      bodyStr.includes(email),
      false,
      'Landlord response must never contain tenant email'
    );
    assert.equal(
      bodyStr.includes(user.id),
      false,
      'Landlord response must never contain tenant user ID'
    );
    assert.equal(
      bodyStr.includes('password'),
      false,
      'Landlord response must never contain password hash'
    );
    assert.equal(
      bodyStr.includes(token),
      false,
      'Landlord response must not echo raw invite token'
    );
  });

  it('tenant ownership isolation: other tenant cannot view comparison (404)', async () => {
    const { agent: agentA } = await createRegisteredAgent('Owner Tenant');
    const { agent: agentB } = await createRegisteredAgent('Snooping Tenant');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agentA);

    await agentA.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agentA
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    const inspRes = await agentA
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agentA
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }
    await agentA.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    // Agent B gets 404
    const res = await agentB
      .get(`/api/tenancies/${tenancyId}/comparison`)
      .expect(404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });

  it('landlord acknowledgement permanently locks move-out inspection', async () => {
    const { agent } = await createRegisteredAgent('Acknowledge Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agent
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    // Landlord acknowledges
    const ackRes = await request(app)
      .post(`/api/landlord/${token}/inspections/${moveOutId}/acknowledge`)
      .send({ name: 'Landlord Jane' })
      .expect(200);

    assert.equal(ackRes.body.inspection.status, 'acknowledged');
    assert.equal(ackRes.body.inspection.acknowledged_by_name, 'Landlord Jane');

    // Attempting to acknowledge again returns 409
    const secondAck = await request(app)
      .post(`/api/landlord/${token}/inspections/${moveOutId}/acknowledge`)
      .send({ name: 'Landlord Jane Again' })
      .expect(409);
    assert.equal(secondAck.body.error.code, 'INVALID_STATE');

    // Raw SQL update blocked by trigger
    await assert.rejects(
      () =>
        pool.query(`UPDATE inspections SET status = 'draft' WHERE id = $1`, [
          moveOutId,
        ]),
      (err) => {
        assert.match(
          err.message,
          /inspection is acknowledged and cannot be modified/i
        );
        return true;
      }
    );

    // Verify comparison is STILL accessible to both tenant and landlord after acknowledgement
    const compAfterAck = await agent
      .get(`/api/tenancies/${tenancyId}/comparison`)
      .expect(200);
    assert.equal(compAfterAck.body.moveOutInspection.status, 'acknowledged');

    const landlordCompAfterAck = await request(app)
      .get(`/api/landlord/${token}/comparison`)
      .expect(200);
    assert.equal(
      landlordCompAfterAck.body.moveOutInspection.status,
      'acknowledged'
    );
  });

  it('request-changes on move-out returns 409 INVALID_STATE', async () => {
    const { agent } = await createRegisteredAgent('Request Changes Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agent
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    // Requesting changes on move-out inspection
    const reqChangeRes = await request(app)
      .post(`/api/landlord/${token}/inspections/${moveOutId}/request-changes`)
      .send({
        name: 'Landlord Jane',
        note: 'Please recheck the refrigerator condition',
      })
      .expect(409);

    assert.equal(reqChangeRes.body.error.code, 'INVALID_STATE');
    assert.match(
      reqChangeRes.body.error.message,
      /only be requested for move-in/i
    );
  });

  it('token-safe error handling and privacy headers on landlord comparison', async () => {
    const bogusToken = 'd'.repeat(43);

    const res404 = await request(app)
      .get(`/api/landlord/${bogusToken}/comparison`)
      .expect(404);

    assert.equal(res404.body.error.code, 'INVALID_LINK');
    assert.equal(
      JSON.stringify(res404.body).includes(bogusToken),
      false,
      'Error body must NOT echo the token'
    );
    assert.equal(res404.headers['cache-control'], 'no-store');
    assert.equal(res404.headers['referrer-policy'], 'no-referrer');

    // Test expired token handling on comparison endpoint
    const { agent } = await createRegisteredAgent('Expired Comp Tester');
    const { tenancyId, moveInId } = await setupActiveTenancyWithMoveIn(agent);
    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);
    const startRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = startRes.body.inspection.id;

    const inspRes = await agent
      .get(`/api/inspections/${moveOutId}`)
      .expect(200);
    for (const it of inspRes.body.items) {
      await agent
        .patch(`/api/items/${it.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    await pool.query(
      `UPDATE invites SET expires_at = now() - interval '1 hour' WHERE tenancy_id = $1`,
      [tenancyId]
    );

    const res410 = await request(app)
      .get(`/api/landlord/${token}/comparison`)
      .expect(410);
    assert.equal(res410.body.error.code, 'LINK_EXPIRED');
    assert.equal(
      JSON.stringify(res410.body).includes(token),
      false,
      'Expired error body must NOT echo the token'
    );
    assert.equal(res410.headers['cache-control'], 'no-store');
    assert.equal(res410.headers['referrer-policy'], 'no-referrer');
  });
});
