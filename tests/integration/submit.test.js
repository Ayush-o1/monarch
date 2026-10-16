import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { LocalStorage } from '../../src/lib/storage/local.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('Inspection Submit and Change Requests', () => {
  let app;
  let tmpUploadDir;
  let storage;

  before(async () => {
    await ensureTestDb();
    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-submit-test-')
    );
    storage = new LocalStorage(tmpUploadDir);
    app = createApp({
      pool,
      storage,
      authLimiter: (_req, _res, next) => next(),
      mediaLimiter: (_req, _res, next) => next(),
    });
  });

  after(async () => {
    await pool.end();
    if (tmpUploadDir && fs.existsSync(tmpUploadDir)) {
      fs.rmSync(tmpUploadDir, { recursive: true, force: true });
    }
  });

  function randomEmail() {
    return `submit_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
  }

  async function createRegisteredAgent(name = 'Tenant') {
    const agent = request.agent(app);
    const email = randomEmail();
    const res = await agent
      .post('/api/auth/register')
      .send({ name, email, password: 'password1234' })
      .expect(201);
    return { agent, user: res.body };
  }

  async function createTenancyWithInspection(agent) {
    const res = await agent
      .post('/api/tenancies')
      .send({
        property_label: `Prop ${Date.now()}`,
        deposit_paise: 5000000,
      })
      .expect(201);
    return {
      tenancy: res.body,
      inspectionId: res.body.inspections.moveIn.id,
    };
  }

  it('no items returns 422 NO_ITEMS', async () => {
    const { agent } = await createRegisteredAgent('No Items Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    const res = await agent
      .post(`/api/inspections/${inspectionId}/submit`)
      .expect(422);

    assert.equal(res.body.error.code, 'NO_ITEMS');
  });

  it('item without condition returns 422 INCOMPLETE_ITEMS listing incomplete items', async () => {
    const { agent } = await createRegisteredAgent('Incomplete Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    // Create item with condition
    await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Hall', name: 'Sofa', condition: 'good' })
      .expect(201);

    // Create item without condition
    const resIncomplete = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Kitchen', name: 'Microwave' })
      .expect(201);

    const submitRes = await agent
      .post(`/api/inspections/${inspectionId}/submit`)
      .expect(422);

    assert.equal(submitRes.body.error.code, 'INCOMPLETE_ITEMS');
    assert.ok(Array.isArray(submitRes.body.error.details));
    assert.equal(submitRes.body.error.details.length, 1);
    assert.equal(submitRes.body.error.details[0].id, resIncomplete.body.id);
    assert.equal(submitRes.body.error.details[0].room, 'Kitchen');
    assert.equal(submitRes.body.error.details[0].name, 'Microwave');
  });

  it('successful submit sets status to submitted and records inspection_submitted event', async () => {
    const { agent } = await createRegisteredAgent('Submit Success Tester');
    const { tenancy, inspectionId } = await createTenancyWithInspection(agent);

    await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Bedroom', name: 'Bed', condition: 'good' })
      .expect(201);

    await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Bedroom', name: 'Wardrobe', condition: 'minor_wear' })
      .expect(201);

    const submitRes = await agent
      .post(`/api/inspections/${inspectionId}/submit`)
      .expect(200);

    assert.equal(submitRes.body.inspection.status, 'submitted');
    assert.ok(submitRes.body.inspection.submitted_at);
    assert.equal(submitRes.body.warnings.itemsWithoutPhotos, 2);

    // Check inspection state via GET
    const getRes = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);
    assert.equal(getRes.body.status, 'submitted');
    assert.equal(getRes.body.lastChangeRequest, null);

    // Verify inspection_submitted event in timeline
    const eventsRes = await agent
      .get(`/api/tenancies/${tenancy.id}/events`)
      .expect(200);
    const submitEvent = eventsRes.body.find(
      (e) => e.type === 'inspection_submitted'
    );
    assert.ok(submitEvent);
    assert.equal(submitEvent.payload.inspectionId, inspectionId);
    assert.equal(submitEvent.payload.type, 'move_in');
    assert.equal(submitEvent.payload.itemCount, 2);
    assert.equal(submitEvent.payload.itemsWithoutPhotos, 2);
  });

  it('submitting twice returns 409 INSPECTION_NOT_DRAFT', async () => {
    const { agent } = await createRegisteredAgent('Double Submit Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Living', name: 'TV', condition: 'good' })
      .expect(201);

    await agent.post(`/api/inspections/${inspectionId}/submit`).expect(200);

    const secondRes = await agent
      .post(`/api/inspections/${inspectionId}/submit`)
      .expect(409);
    assert.equal(secondRes.body.error.code, 'INSPECTION_NOT_DRAFT');
  });

  it('another user submitting returns 404 NOT_FOUND', async () => {
    const userA = await createRegisteredAgent('User A');
    const userB = await createRegisteredAgent('User B');
    const { inspectionId } = await createTenancyWithInspection(userA.agent);

    await userA.agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Room', name: 'Item', condition: 'good' })
      .expect(201);

    await userB.agent
      .post(`/api/inspections/${inspectionId}/submit`)
      .expect(404);

    const fakeId = crypto.randomUUID();
    await userA.agent.post(`/api/inspections/${fakeId}/submit`).expect(404);
  });

  it('tenant edits after submit return 409 (item patch, item create, media upload, media delete)', async () => {
    const { agent } = await createRegisteredAgent('Locked Edits Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    const itemRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Room', name: 'Desk', condition: 'good' })
      .expect(201);
    const itemId = itemRes.body.id;

    // Submit inspection
    await agent.post(`/api/inspections/${inspectionId}/submit`).expect(200);

    // 1. Item create returns 409
    await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Room', name: 'Chair', condition: 'good' })
      .expect(409);

    // 2. Item patch returns 409
    await agent
      .patch(`/api/items/${itemId}`)
      .send({ condition: 'damaged' })
      .expect(409);

    // 3. Media upload returns 409
    const dummyImage = Buffer.from('dummy');
    await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', dummyImage, 'photo.jpg')
      .expect(409);

    // 4. Item delete returns 409
    await agent.delete(`/api/items/${itemId}`).expect(409);
  });

  it('resubmit allowed after landlord request-changes and lastChangeRequest is shown', async () => {
    const { agent } = await createRegisteredAgent('Resubmit Tester');
    const { tenancy, inspectionId } = await createTenancyWithInspection(agent);

    const itemRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Kitchen', name: 'Sink', condition: 'good' })
      .expect(201);
    const itemId = itemRes.body.id;

    // Submit
    await agent.post(`/api/inspections/${inspectionId}/submit`).expect(200);

    // Simulate landlord requesting changes (sets status='draft', submitted_at=null, records event)
    await pool.query(
      `UPDATE inspections SET status = 'draft', submitted_at = NULL WHERE id = $1`,
      [inspectionId]
    );

    const noteText = 'Please provide clearer photo of the faucet';
    await pool.query(
      `INSERT INTO events (tenancy_id, actor_type, actor_label, type, payload)
       VALUES ($1, 'landlord', 'Landlord Jane', 'changes_requested', $2)`,
      [tenancy.id, JSON.stringify({ inspectionId, note: noteText })]
    );

    // Tenant reads inspection: lastChangeRequest is present
    const getRes = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);
    assert.equal(getRes.body.status, 'draft');
    assert.ok(getRes.body.lastChangeRequest);
    assert.equal(getRes.body.lastChangeRequest.note, noteText);
    assert.equal(getRes.body.lastChangeRequest.by, 'Landlord Jane');
    assert.ok(getRes.body.lastChangeRequest.at);

    // Tenant can edit item again
    await agent
      .patch(`/api/items/${itemId}`)
      .send({ note: 'Re-checked the faucet; all clean' })
      .expect(200);

    // Resubmit succeeds
    const resubmitRes = await agent
      .post(`/api/inspections/${inspectionId}/submit`)
      .expect(200);
    assert.equal(resubmitRes.body.inspection.status, 'submitted');

    // After resubmit, lastChangeRequest is null because status is submitted
    const getResSubmitted = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);
    assert.equal(getResSubmitted.body.lastChangeRequest, null);
  });
});
