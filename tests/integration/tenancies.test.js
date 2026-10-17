import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { createTenancy } from '../../src/modules/tenancies/service.js';

describe('Tenancies, Inspections, and Events API', () => {
  let app;

  before(async () => {
    await ensureTestDb();
    app = createApp({ pool, authLimiter: (_req, _res, next) => next() });
  });

  after(async () => {
    await pool.end();
  });

  function randomEmail() {
    return `tenancy_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
  }

  async function createRegisteredAgent(name = 'Test Tenant') {
    const agent = request.agent(app);
    const email = randomEmail();
    const res = await agent
      .post('/api/auth/register')
      .send({ name, email, password: 'password1234' })
      .expect(201);
    return { agent, user: res.body };
  }

  it('unauthenticated requests to tenancy routes return 401 UNAUTHORIZED', async () => {
    await request(app).get('/api/tenancies').expect(401);
    await request(app)
      .post('/api/tenancies')
      .send({ propertyLabel: 'Flat 1', depositPaise: 5000000 })
      .expect(401);
    await request(app).get(`/api/tenancies/${crypto.randomUUID()}`).expect(401);
    await request(app)
      .get(`/api/tenancies/${crypto.randomUUID()}/events`)
      .expect(401);
  });

  it('createTenancy runs in ONE transaction: rolls back completely if recordEvent throws', async () => {
    const { user } = await createRegisteredAgent('Rollback Tester');

    const failingRecordEvent = async () => {
      throw new Error('Simulated event recording failure');
    };

    const uniqueLabel = `Rollback Test Property ${Date.now()}`;

    await assert.rejects(async () => {
      await createTenancy(
        {
          tenantId: user.id,
          actorName: user.name,
          propertyLabel: uniqueLabel,
          depositPaise: 2500000,
        },
        { pool, recordEventFn: failingRecordEvent }
      );
    }, /Simulated event recording failure/);

    // Verify neither tenancy nor inspection was saved
    const tenancyCheck = await pool.query(
      `SELECT * FROM tenancies WHERE property_label = $1`,
      [uniqueLabel]
    );
    assert.equal(tenancyCheck.rowCount, 0);

    const inspectionCheck = await pool.query(
      `SELECT i.* FROM inspections i
       JOIN tenancies t ON t.id = i.tenancy_id
       WHERE t.property_label = $1`,
      [uniqueLabel]
    );
    assert.equal(inspectionCheck.rowCount, 0);
  });

  it('creates tenancy, draft move_in inspection, and tenancy_created event successfully', async () => {
    const { agent, user } = await createRegisteredAgent('Alice Tenant');

    const payload = {
      propertyLabel: 'Flat 402, Oak Residency',
      address: '4th Cross, Indiranagar, Bengaluru',
      landlordName: 'Mr. Sharma',
      depositPaise: 5000000,
      refundWindowDays: 30,
      leaseStartDate: '2026-11-01',
    };

    const createRes = await agent
      .post('/api/tenancies')
      .send(payload)
      .expect(201);

    const tenancyId = createRes.body.id;
    assert.ok(tenancyId);
    assert.equal(createRes.body.property_label, 'Flat 402, Oak Residency');
    assert.equal(createRes.body.landlord_name, 'Mr. Sharma');
    assert.equal(createRes.body.deposit_paise, 5000000);
    assert.equal(typeof createRes.body.deposit_paise, 'number');
    assert.equal(createRes.body.status, 'active');
    assert.ok(createRes.body.inspections.moveIn);
    assert.equal(createRes.body.inspections.moveIn.status, 'draft');
    assert.equal(createRes.body.inspections.moveIn.type, 'move_in');
    assert.equal(createRes.body.inspections.moveOut, null);

    // List tenancies
    const listRes = await agent.get('/api/tenancies').expect(200);
    assert.ok(Array.isArray(listRes.body));
    const found = listRes.body.find((t) => t.id === tenancyId);
    assert.ok(found);
    assert.equal(found.property_label, 'Flat 402, Oak Residency');
    assert.equal(found.deposit_paise, 5000000);
    assert.equal(typeof found.deposit_paise, 'number');
    assert.equal(found.move_in_status, 'draft');

    // Tenancy details
    const getRes = await agent.get(`/api/tenancies/${tenancyId}`).expect(200);
    assert.equal(getRes.body.id, tenancyId);
    assert.equal(getRes.body.property_label, 'Flat 402, Oak Residency');
    assert.equal(getRes.body.inspections.moveIn.status, 'draft');

    // Timeline events
    const eventsRes = await agent
      .get(`/api/tenancies/${tenancyId}/events`)
      .expect(200);
    assert.ok(Array.isArray(eventsRes.body));
    assert.equal(eventsRes.body.length, 1);
    const event = eventsRes.body[0];
    assert.equal(event.type, 'tenancy_created');
    assert.equal(event.actor_type, 'tenant');
    assert.equal(event.actor_label, user.name);
    assert.equal(event.payload.depositPaise, 5000000);
    assert.equal(event.payload.propertyLabel, 'Flat 402, Oak Residency');
  });

  it('isolates tenancies across users: another user receives 404 (IDOR prevention)', async () => {
    const userA = await createRegisteredAgent('User A');
    const userB = await createRegisteredAgent('User B');

    // User A creates a tenancy
    const createRes = await userA.agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Secret Penthouse',
        depositPaise: 90000000,
      })
      .expect(201);

    const tenancyId = createRes.body.id;

    // User B lists tenancies: must not see User A's tenancy
    const listRes = await userB.agent.get('/api/tenancies').expect(200);
    assert.equal(
      listRes.body.some((t) => t.id === tenancyId),
      false
    );

    // User B attempts to get User A's tenancy directly: 404
    await userB.agent.get(`/api/tenancies/${tenancyId}`).expect(404);

    // User B attempts to get events for User A's tenancy: 404
    await userB.agent.get(`/api/tenancies/${tenancyId}/events`).expect(404);
  });

  it('malformed uuid in path returns 404 NOT_FOUND instead of 500 cast error', async () => {
    const { agent } = await createRegisteredAgent('UUID Tester');

    const res1 = await agent.get('/api/tenancies/not-a-valid-uuid').expect(404);
    assert.equal(res1.body.error.code, 'NOT_FOUND');

    const res2 = await agent.get('/api/tenancies/12345/events').expect(404);
    assert.equal(res2.body.error.code, 'NOT_FOUND');
  });

  it('validates propertyLabel: 1..80 chars, rejects empty, whitespace, and > 80 chars', async () => {
    const { agent } = await createRegisteredAgent('Validation Tester');

    // Empty propertyLabel
    const emptyRes = await agent
      .post('/api/tenancies')
      .send({ propertyLabel: '', depositPaise: 5000000 })
      .expect(400);
    assert.equal(emptyRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(emptyRes.body.error.details.propertyLabel);

    // Whitespace-only propertyLabel
    const wsRes = await agent
      .post('/api/tenancies')
      .send({ propertyLabel: '    ', depositPaise: 5000000 })
      .expect(400);
    assert.equal(wsRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(wsRes.body.error.details.propertyLabel);

    // Exceeding 80 chars
    const longRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'A'.repeat(81),
        depositPaise: 5000000,
      })
      .expect(400);
    assert.equal(longRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(longRes.body.error.details.propertyLabel);
  });

  it('validates depositPaise: integer 1..1_000_000_000 (rejects decimals, strings, negatives, 0, > 1B)', async () => {
    const { agent } = await createRegisteredAgent('Deposit Tester');

    // Decimal paise (e.g. 500.5)
    const decRes = await agent
      .post('/api/tenancies')
      .send({ propertyLabel: 'Valid Label', depositPaise: 500.5 })
      .expect(400);
    assert.equal(decRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(decRes.body.error.details.depositPaise);

    // String number (e.g. "50000")
    const strRes = await agent
      .post('/api/tenancies')
      .send({ propertyLabel: 'Valid Label', depositPaise: '50000' })
      .expect(400);
    assert.equal(strRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(strRes.body.error.details.depositPaise);

    // Zero
    const zeroRes = await agent
      .post('/api/tenancies')
      .send({ propertyLabel: 'Valid Label', depositPaise: 0 })
      .expect(400);
    assert.equal(zeroRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(zeroRes.body.error.details.depositPaise);

    // Negative
    const negRes = await agent
      .post('/api/tenancies')
      .send({ propertyLabel: 'Valid Label', depositPaise: -100 })
      .expect(400);
    assert.equal(negRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(negRes.body.error.details.depositPaise);

    // Exceeding 1,000,000,000
    const maxRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Label',
        depositPaise: 1000000001,
      })
      .expect(400);
    assert.equal(maxRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(maxRes.body.error.details.depositPaise);
  });

  it('validates optional fields: address <= 300, landlordName <= 80, refundWindowDays 1..365, leaseStartDate date', async () => {
    const { agent } = await createRegisteredAgent('Optional Tester');

    // Address > 300
    const addrRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Label',
        depositPaise: 500000,
        address: 'X'.repeat(301),
      })
      .expect(400);
    assert.equal(addrRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(addrRes.body.error.details.address);

    // Landlord name > 80
    const landRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Label',
        depositPaise: 500000,
        landlordName: 'L'.repeat(81),
      })
      .expect(400);
    assert.equal(landRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(landRes.body.error.details.landlordName);

    // Refund window < 1 or > 365 or decimal
    const winRes1 = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Label',
        depositPaise: 500000,
        refundWindowDays: 0,
      })
      .expect(400);
    assert.equal(winRes1.body.error.code, 'VALIDATION_ERROR');
    assert.ok(winRes1.body.error.details.refundWindowDays);

    const winRes2 = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Label',
        depositPaise: 500000,
        refundWindowDays: 366,
      })
      .expect(400);
    assert.equal(winRes2.body.error.code, 'VALIDATION_ERROR');
    assert.ok(winRes2.body.error.details.refundWindowDays);

    // Lease start date not a valid date
    const dateRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Label',
        depositPaise: 500000,
        leaseStartDate: 'invalid-date',
      })
      .expect(400);
    assert.equal(dateRes.body.error.code, 'VALIDATION_ERROR');
    assert.ok(dateRes.body.error.details.leaseStartDate);
  });

  it('strict schema: snake_case keys are rejected with 400 VALIDATION_ERROR', async () => {
    const { agent } = await createRegisteredAgent('Strict Snake Tester');

    const res = await agent
      .post('/api/tenancies')
      .send({
        property_label: 'Snake Flat',
        deposit_paise: 5000000,
      })
      .expect(400);

    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      res.body.error.details.body &&
        res.body.error.details.body.includes('property_label')
    );
  });

  it('strict schema: unknown extra key is rejected with 400 VALIDATION_ERROR', async () => {
    const { agent } = await createRegisteredAgent('Strict Unknown Key Tester');

    const res = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Valid Flat',
        depositPaise: 5000000,
        unknownExtraKey: 'unexpected value',
      })
      .expect(400);

    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.ok(
      res.body.error.details.body &&
        res.body.error.details.body.includes('unknownExtraKey')
    );
  });
});
