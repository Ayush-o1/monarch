import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { LocalStorage } from '../../src/lib/storage/local.js';
import { createLandlordRateLimiter } from '../../src/middleware/rateLimits.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';

describe('Landlord Token API and Locking Invariants', () => {
  let app;
  let tmpUploadDir;
  let storage;

  before(async () => {
    await ensureTestDb();
    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-landlord-test-')
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
    return `landlord_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
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

  async function makeValidJpeg(width = 50, height = 50) {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();
  }

  async function setupTenancyWithSubmittedInspection() {
    const { agent, user } = await createRegisteredAgent('John Doe');

    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        property_label: `Apartment 101 (${Date.now()})`,
        address: '100 Baker Street',
        landlord_name: 'Mr. Baker',
        deposit_paise: 5000000,
        refund_window_days: 14,
        lease_start_date: '2026-10-01',
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const inspectionId = tenancyRes.body.inspections.moveIn.id;

    // Add item
    const itemRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({
        room: 'Kitchen',
        name: 'Refrigerator',
        condition: 'good',
        note: 'Spotless',
      })
      .expect(201);
    const itemId = itemRes.body.id;

    // Upload photo
    const validJpeg = await makeValidJpeg(60, 60);
    const uploadRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', validJpeg, 'fridge.jpg')
      .expect(201);
    const mediaId = uploadRes.body.id;

    // Submit inspection
    await agent.post(`/api/inspections/${inspectionId}/submit`).expect(200);

    // Create landlord invite
    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    return {
      agent,
      user,
      tenancyId,
      inspectionId,
      itemId,
      mediaId,
      token,
    };
  }

  it('GET /api/landlord/:token/tenancy returns data without user email, id, or password_hash', async () => {
    const { token, user, inspectionId, itemId, mediaId } =
      await setupTenancyWithSubmittedInspection();

    const res = await request(app)
      .get(`/api/landlord/${token}/tenancy`)
      .expect(200)
      .expect('Cache-Control', /no-store/)
      .expect('Referrer-Policy', 'no-referrer');

    const bodyStr = JSON.stringify(res.body);

    // Assert sensitive fields are absent
    assert.equal(
      bodyStr.includes(user.email),
      false,
      'Tenant email must never be in response'
    );
    assert.equal(
      bodyStr.includes(user.id),
      false,
      'Tenant id must never be in response'
    );
    assert.equal(
      bodyStr.includes('password_hash'),
      false,
      'password_hash must never be in response'
    );

    // Assert structure
    assert.ok(res.body.tenancy);
    assert.equal(res.body.tenancy.tenantName, user.name);
    assert.equal(res.body.tenancy.depositPaise, 5000000);
    assert.equal(
      res.body.tenancy.propertyLabel.startsWith('Apartment 101'),
      true
    );

    assert.ok(Array.isArray(res.body.inspections));
    assert.equal(res.body.inspections.length, 1);
    const insp = res.body.inspections[0];
    assert.equal(insp.id, inspectionId);
    assert.equal(insp.status, 'submitted');
    assert.equal(insp.items.length, 1);
    assert.equal(insp.items[0].id, itemId);
    assert.equal(insp.items[0].room, 'Kitchen');
    assert.equal(insp.items[0].name, 'Refrigerator');
    assert.equal(insp.items[0].condition, 'good');
    assert.equal(insp.items[0].note, 'Spotless');
    assert.equal(insp.items[0].media.length, 1);
    assert.equal(insp.items[0].media[0].id, mediaId);
  });

  it('draft inspection is not visible to landlord', async () => {
    const { agent } = await createRegisteredAgent('Draft Invisible Tester');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({ property_label: 'Draft Prop', deposit_paise: 3000000 })
      .expect(201);
    const tenancyId = tenancyRes.body.id;

    // Inspection is still draft
    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    const res = await request(app)
      .get(`/api/landlord/${token}/tenancy`)
      .expect(200);

    assert.equal(
      res.body.inspections.length,
      0,
      'Draft inspection must not be visible to landlord'
    );
  });

  it('landlord cannot read media of another tenancy or of a draft inspection (404)', async () => {
    const t1 = await setupTenancyWithSubmittedInspection();
    const t2 = await setupTenancyWithSubmittedInspection();

    // Landlord 1 tries to read media belonging to Tenancy 2 -> 404
    await request(app)
      .get(`/api/landlord/${t1.token}/media/${t2.mediaId}`)
      .expect(404);

    // Landlord 1 tries to read media from a draft inspection
    // Create new item and media in a draft inspection of Tenancy 1
    const { agent } = await createRegisteredAgent('Draft Media Tenant');
    const draftTenancy = await agent
      .post('/api/tenancies')
      .send({ property_label: 'Draft Media Prop', deposit_paise: 2000000 })
      .expect(201);
    const draftInspId = draftTenancy.body.inspections.moveIn.id;

    const item = await agent
      .post(`/api/inspections/${draftInspId}/items`)
      .send({ room: 'Bath', name: 'Mirror', condition: 'good' })
      .expect(201);

    const validJpeg = await makeValidJpeg(70, 70);
    const upload = await agent
      .post(`/api/items/${item.body.id}/media`)
      .attach('photo', validJpeg, 'mirror.jpg')
      .expect(201);

    const draftInvite = await agent
      .post(`/api/tenancies/${draftTenancy.body.id}/invite`)
      .expect(201);
    const draftToken = draftInvite.body.url.split('/l/')[1];

    // Landlord tries to read media of draft inspection -> 404
    await request(app)
      .get(`/api/landlord/${draftToken}/media/${upload.body.id}`)
      .expect(404);

    // But landlord of submitted inspection can read their media
    await request(app)
      .get(`/api/landlord/${t1.token}/media/${t1.mediaId}`)
      .expect(200)
      .expect('Content-Type', 'image/jpeg');
  });

  it('acknowledge records landlord name, locks inspection, and blocks further mutations', async () => {
    const { token, agent, inspectionId, itemId } =
      await setupTenancyWithSubmittedInspection();

    // Missing or invalid name validation
    await request(app)
      .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
      .send({})
      .expect(400);

    await request(app)
      .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
      .send({ name: '   ' })
      .expect(400);

    await request(app)
      .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
      .send({ name: 'x'.repeat(81) })
      .expect(400);

    // Acknowledge successfully
    const ackRes = await request(app)
      .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
      .send({ name: 'Landlord Jane' })
      .expect(200);

    assert.equal(ackRes.body.inspection.status, 'acknowledged');
    assert.equal(ackRes.body.inspection.acknowledged_by_name, 'Landlord Jane');
    assert.ok(ackRes.body.inspection.acknowledged_at);

    // Second acknowledge returns 409 INVALID_STATE
    const secondAck = await request(app)
      .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
      .send({ name: 'Landlord Jane' })
      .expect(409);
    assert.equal(secondAck.body.error.code, 'INVALID_STATE');

    // Tenant operations all return 409
    await agent
      .patch(`/api/items/${itemId}`)
      .send({ condition: 'damaged' })
      .expect(409);

    const dummyJpeg = Buffer.from('dummy');
    await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', dummyJpeg, 'photo.jpg')
      .expect(409);

    await agent.delete(`/api/items/${itemId}`).expect(409);

    // Raw SQL update on acknowledged inspection fails (trigger invariant)
    await assert.rejects(async () => {
      await pool.query(
        `UPDATE inspections SET acknowledged_by_name = 'Hacker' WHERE id = $1`,
        [inspectionId]
      );
    }, /inspection is acknowledged and cannot be modified/i);
  });

  it('request-changes on move_in returns it to draft, shows note, and allows tenant edits', async () => {
    const { token, agent, inspectionId, itemId } =
      await setupTenancyWithSubmittedInspection();

    // Validation
    await request(app)
      .post(
        `/api/landlord/${token}/inspections/${inspectionId}/request-changes`
      )
      .send({ name: 'Landlord Bob', note: '' })
      .expect(400);

    await request(app)
      .post(
        `/api/landlord/${token}/inspections/${inspectionId}/request-changes`
      )
      .send({ name: '', note: 'Valid note' })
      .expect(400);

    // Successful request-changes
    const reqRes = await request(app)
      .post(
        `/api/landlord/${token}/inspections/${inspectionId}/request-changes`
      )
      .send({
        name: 'Landlord Bob',
        note: 'Please photograph the freezer interior',
      })
      .expect(200);

    assert.equal(reqRes.body.inspection.status, 'draft');
    assert.equal(reqRes.body.inspection.submitted_at, null);

    // Tenant checks inspection: lastChangeRequest has note and author
    const getInsp = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);
    assert.equal(getInsp.body.status, 'draft');
    assert.ok(getInsp.body.lastChangeRequest);
    assert.equal(getInsp.body.lastChangeRequest.by, 'Landlord Bob');
    assert.equal(
      getInsp.body.lastChangeRequest.note,
      'Please photograph the freezer interior'
    );

    // Tenant can edit item again
    await agent
      .patch(`/api/items/${itemId}`)
      .send({ note: 'Added freezer interior photos' })
      .expect(200);

    // Tenant can resubmit
    await agent.post(`/api/inspections/${inspectionId}/submit`).expect(200);
  });

  it('request-changes with tenancy not active returns 409; request-changes on move_out is rejected (409)', async () => {
    const { token, tenancyId, inspectionId } =
      await setupTenancyWithSubmittedInspection();

    // 1. Move-out inspection rejection
    const moveOutRes = await pool.query(
      `INSERT INTO inspections (tenancy_id, type, status) VALUES ($1, 'move_out', 'submitted') RETURNING id`,
      [tenancyId]
    );
    const moveOutId = moveOutRes.rows[0].id;

    const outReqRes = await request(app)
      .post(`/api/landlord/${token}/inspections/${moveOutId}/request-changes`)
      .send({ name: 'Landlord Bob', note: 'Not allowed on move-out' })
      .expect(409);
    assert.equal(outReqRes.body.error.code, 'INVALID_STATE');

    // 2. Tenancy not active rejection
    await pool.query(`UPDATE tenancies SET status = 'closed' WHERE id = $1`, [
      tenancyId,
    ]);

    const nonActiveRes = await request(app)
      .post(
        `/api/landlord/${token}/inspections/${inspectionId}/request-changes`
      )
      .send({
        name: 'Landlord Bob',
        note: 'Cannot request changes when closed',
      })
      .expect(409);
    assert.equal(nonActiveRes.body.error.code, 'INVALID_STATE');
  });

  it('two simultaneous acknowledges: one 200, one 409', async () => {
    const { token, inspectionId } = await setupTenancyWithSubmittedInspection();

    const [ack1, ack2] = await Promise.all([
      request(app)
        .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
        .send({ name: 'Landlord One' }),
      request(app)
        .post(`/api/landlord/${token}/inspections/${inspectionId}/acknowledge`)
        .send({ name: 'Landlord Two' }),
    ]);

    const statuses = [ack1.status, ack2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  });

  it('concurrency: acknowledge and request-changes fired together 20 times: exactly one 200 and one 409 each round', async () => {
    for (let i = 0; i < 20; i++) {
      const { token, inspectionId } =
        await setupTenancyWithSubmittedInspection();

      const [resAck, resReq] = await Promise.all([
        request(app)
          .post(
            `/api/landlord/${token}/inspections/${inspectionId}/acknowledge`
          )
          .send({ name: 'Landlord A' }),
        request(app)
          .post(
            `/api/landlord/${token}/inspections/${inspectionId}/request-changes`
          )
          .send({ name: 'Landlord B', note: 'Changes needed' }),
      ]);

      const statuses = [resAck.status, resReq.status].sort();
      assert.deepEqual(
        statuses,
        [200, 409],
        `Round ${i + 1}: expected one 200 and one 409`
      );

      // Verify the final status in database matches the winner
      const check = await pool.query(
        `SELECT status FROM inspections WHERE id = $1`,
        [inspectionId]
      );
      const expectedStatus = resAck.status === 200 ? 'acknowledged' : 'draft';
      assert.equal(
        check.rows[0].status,
        expectedStatus,
        `Round ${i + 1}: expected status ${expectedStatus}`
      );
    }
  });

  it('headers and limits: Cache-Control, Referrer-Policy, rate limiting (429), and error bodies never contain token', async () => {
    const { token } = await setupTenancyWithSubmittedInspection();

    // Check GET /l/:token headers
    const pageRes = await request(app).get(`/l/${token}`).expect(200);
    assert.equal(pageRes.headers['cache-control'], 'no-store');
    assert.equal(pageRes.headers['referrer-policy'], 'no-referrer');

    // Check bogus token gives 404 without leaking token in body
    const bogusToken = 'a'.repeat(43);
    const bogusRes = await request(app)
      .get(`/api/landlord/${bogusToken}/tenancy`)
      .expect(404);
    assert.equal(bogusRes.body.error.code, 'INVALID_LINK');
    assert.equal(JSON.stringify(bogusRes.body).includes(bogusToken), false);

    // Check malformed token gives 404 without leaking token in body
    const malformedRes = await request(app)
      .get('/api/landlord/too-short/tenancy')
      .expect(404);
    assert.equal(malformedRes.body.error.code, 'INVALID_LINK');
    assert.equal(
      JSON.stringify(malformedRes.body).includes('too-short'),
      false
    );

    // Rate limiting: create a separate app with a low rate limit (e.g. 5)
    const limitedApp = createApp({
      pool,
      storage,
      authLimiter: (_req, _res, next) => next(),
      mediaLimiter: (_req, _res, next) => next(),
      landlordLimiter: createLandlordRateLimiter({ max: 5 }),
    });

    for (let i = 0; i < 5; i++) {
      await request(limitedApp)
        .get(`/api/landlord/${token}/tenancy`)
        .expect(200);
    }

    const rateRes = await request(limitedApp)
      .get(`/api/landlord/${token}/tenancy`)
      .expect(429);
    assert.equal(rateRes.body.error.code, 'RATE_LIMIT_EXCEEDED');
  });
});
