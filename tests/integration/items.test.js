import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';

describe('Inspection Items API and Locking Invariants', () => {
  let app;

  before(async () => {
    await ensureTestDb();
    app = createApp({ pool, authLimiter: (_req, _res, next) => next() });
  });

  after(async () => {
    await pool.end();
  });

  function randomEmail() {
    return `item_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
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

  it('CRUD in draft status: create item, get inspection, patch item, delete item', async () => {
    const { agent } = await createRegisteredAgent('CRUD Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    // 1. Create item
    const createRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({
        room: 'Living Room',
        name: 'Coffee Table',
        condition: 'good',
        note: 'Teak wood, glass top',
      })
      .expect(201);

    const itemId = createRes.body.id;
    assert.ok(itemId);
    assert.equal(createRes.body.room, 'Living Room');
    assert.equal(createRes.body.name, 'Coffee Table');
    assert.equal(createRes.body.condition, 'good');
    assert.equal(createRes.body.position, 0);

    // 2. Get inspection with items
    const getRes = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);
    assert.equal(getRes.body.id, inspectionId);
    assert.equal(getRes.body.items.length, 1);
    assert.equal(getRes.body.items[0].id, itemId);

    // 3. Patch item
    const patchRes = await agent
      .patch(`/api/items/${itemId}`)
      .send({
        condition: 'minor_wear',
        note: 'Minor surface scratch',
      })
      .expect(200);
    assert.equal(patchRes.body.condition, 'minor_wear');
    assert.equal(patchRes.body.note, 'Minor surface scratch');

    // Clear condition by sending null
    const clearRes = await agent
      .patch(`/api/items/${itemId}`)
      .send({ condition: null })
      .expect(200);
    assert.equal(clearRes.body.condition, null);

    // 4. Delete item
    await agent.delete(`/api/items/${itemId}`).expect(200);

    // Verify empty
    const verifyRes = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);
    assert.equal(verifyRes.body.items.length, 0);
  });

  it('duplicate item (same room and name in different case) returns 409 DUPLICATE_ITEM', async () => {
    const { agent } = await createRegisteredAgent('Duplicate Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Kitchen', name: 'Microwave Oven' })
      .expect(201);

    const dupRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: '  kitchen  ', name: 'MICROWAVE OVEN' })
      .expect(409);

    assert.equal(dupRes.body.error.code, 'DUPLICATE_ITEM');
  });

  it('two simultaneous creates of the same item give one 201 and one 409', async () => {
    const { agent } = await createRegisteredAgent('Race Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    const payload = { room: 'Bedroom', name: 'Ceiling Fan', condition: 'good' };

    const [res1, res2] = await Promise.all([
      agent.post(`/api/inspections/${inspectionId}/items`).send(payload),
      agent.post(`/api/inspections/${inspectionId}/items`).send(payload),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const failRes = res1.status === 409 ? res1 : res2;
    assert.equal(failRes.body.error.code, 'DUPLICATE_ITEM');
  });

  it('validation: invalid condition returns 400', async () => {
    const { agent } = await createRegisteredAgent('Val Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    const res = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Bath', name: 'Mirror', condition: 'broken' })
      .expect(400);

    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(res.body.error.details.condition);
  });

  it('validation: unknown key returns 400', async () => {
    const { agent } = await createRegisteredAgent('Strict Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    // Create with unknown key
    const createRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({
        room: 'Balcony',
        name: 'Railing',
        extraField: 'not allowed',
      })
      .expect(400);
    assert.equal(createRes.body.error.code, 'VALIDATION_ERROR');

    // Create valid item first
    const item = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Balcony', name: 'Railing' })
      .expect(201);

    // Patch with unknown key
    const patchRes = await agent
      .patch(`/api/items/${item.body.id}`)
      .send({ unknown_param: 123 })
      .expect(400);
    assert.equal(patchRes.body.error.code, 'VALIDATION_ERROR');
  });

  it('301st item gives 422 TOO_MANY_ITEMS', async () => {
    const { agent } = await createRegisteredAgent('Cap Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    // Fast batch insert of 300 rows using raw SQL
    const values = [];
    for (let i = 0; i < 300; i++) {
      values.push(
        `('${crypto.randomUUID()}', '${inspectionId}', 'Room', 'Item ${i}', 'good', ${i})`
      );
    }
    await pool.query(
      `INSERT INTO inspection_items (id, inspection_id, room, name, condition, position)
       VALUES ${values.join(', ')}`
    );

    // Attempt 301st item via API
    const res = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Room', name: 'Item 300' })
      .expect(422);

    assert.equal(res.body.error.code, 'TOO_MANY_ITEMS');
  });

  it('IDOR prevention: another user cannot access inspection or item (returns 404)', async () => {
    const userA = await createRegisteredAgent('User A');
    const userB = await createRegisteredAgent('User B');

    const { inspectionId } = await createTenancyWithInspection(userA.agent);
    const itemRes = await userA.agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Study', name: 'Desk' })
      .expect(201);
    const itemId = itemRes.body.id;

    // User B tries to GET inspection of User A
    await userB.agent.get(`/api/inspections/${inspectionId}`).expect(404);

    // User B tries to create item in User A's inspection
    await userB.agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Study', name: 'Chair' })
      .expect(404);

    // User B tries to patch User A's item
    await userB.agent
      .patch(`/api/items/${itemId}`)
      .send({ condition: 'damaged' })
      .expect(404);

    // User B tries to delete User A's item
    await userB.agent.delete(`/api/items/${itemId}`).expect(404);
  });

  it('malformed uuid in path returns 404 NOT_FOUND', async () => {
    const { agent } = await createRegisteredAgent('UUID Tester');

    const res1 = await agent
      .get('/api/inspections/not-a-valid-uuid')
      .expect(404);
    assert.equal(res1.body.error.code, 'NOT_FOUND');

    const res2 = await agent
      .post('/api/inspections/not-a-valid-uuid/items')
      .send({ room: 'Living', name: 'Rug' })
      .expect(404);
    assert.equal(res2.body.error.code, 'NOT_FOUND');

    const res3 = await agent.patch('/api/items/not-a-valid-uuid').expect(404);
    assert.equal(res3.body.error.code, 'NOT_FOUND');

    const res4 = await agent.delete('/api/items/not-a-valid-uuid').expect(404);
    assert.equal(res4.body.error.code, 'NOT_FOUND');
  });

  it('locked inspection (status != draft): API create, patch, delete return 409 INSPECTION_LOCKED', async () => {
    const { agent } = await createRegisteredAgent('Lock Tester');
    const { inspectionId } = await createTenancyWithInspection(agent);

    // Create item while still draft
    const itemRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Garage', name: 'Toolbox' })
      .expect(201);
    const itemId = itemRes.body.id;

    // Set inspection to submitted via raw SQL
    await pool.query(
      `UPDATE inspections SET status = 'submitted' WHERE id = $1`,
      [inspectionId]
    );

    // 1. Create item fails with 409 INSPECTION_LOCKED
    const createLocked = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room: 'Garage', name: 'Ladder' })
      .expect(409);
    assert.equal(createLocked.body.error.code, 'INSPECTION_LOCKED');

    // 2. Patch item fails with 409 INSPECTION_LOCKED
    const patchLocked = await agent
      .patch(`/api/items/${itemId}`)
      .send({ note: 'Cannot update' })
      .expect(409);
    assert.equal(patchLocked.body.error.code, 'INSPECTION_LOCKED');

    // 3. Delete item fails with 409 INSPECTION_LOCKED
    const deleteLocked = await agent.delete(`/api/items/${itemId}`).expect(409);
    assert.equal(deleteLocked.body.error.code, 'INSPECTION_LOCKED');
  });
});
