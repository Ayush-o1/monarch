import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { hashToken } from '../../src/lib/tokens.js';

describe('Invites API and Token Security', () => {
  let app;

  before(async () => {
    await ensureTestDb();
    app = createApp({ pool, authLimiter: (_req, _res, next) => next() });
  });

  after(async () => {
    await pool.end();
  });

  function randomEmail() {
    return `invite_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
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

  async function createTenancy(agent) {
    const res = await agent
      .post('/api/tenancies')
      .send({
        property_label: `Prop ${Date.now()}`,
        deposit_paise: 5000000,
      })
      .expect(201);
    return res.body;
  }

  it('DB stores only the token hash (raw token never saved; token_hash is 64 hex chars)', async () => {
    const { agent } = await createRegisteredAgent('Token Hash Tester');
    const tenancy = await createTenancy(agent);

    const inviteRes = await agent
      .post(`/api/tenancies/${tenancy.id}/invite`)
      .expect(201);

    assert.ok(inviteRes.body.url);
    assert.ok(inviteRes.body.expiresAt);

    // Extract token from URL
    const urlParts = inviteRes.body.url.split('/l/');
    assert.equal(urlParts.length, 2);
    const rawToken = urlParts[1];
    assert.equal(rawToken.length, 43);

    // Query database for the stored invite row
    const dbRes = await pool.query(
      `SELECT * FROM invites WHERE tenancy_id = $1`,
      [tenancy.id]
    );
    assert.equal(dbRes.rowCount, 1);
    const dbRow = dbRes.rows[0];

    assert.notEqual(dbRow.token_hash, rawToken);
    assert.equal(dbRow.token_hash, hashToken(rawToken));
    assert.equal(dbRow.token_hash.length, 64);
    assert.match(dbRow.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(dbRow.revoked_at, null);

    // GET /api/tenancies/:id returns invite without token
    const getTenancy = await agent
      .get(`/api/tenancies/${tenancy.id}`)
      .expect(200);
    assert.equal(getTenancy.body.invite.active, true);
    assert.ok(getTenancy.body.invite.expiresAt);
    assert.equal(getTenancy.body.invite.token, undefined);
    assert.equal(getTenancy.body.invite.token_hash, undefined);
  });

  it('creating a new link revokes the old link and records events', async () => {
    const { agent } = await createRegisteredAgent('Revoke Old Tester');
    const tenancy = await createTenancy(agent);

    // First invite
    const inv1 = await agent
      .post(`/api/tenancies/${tenancy.id}/invite`)
      .expect(201);
    const token1 = inv1.body.url.split('/l/')[1];

    // Second invite
    const inv2 = await agent
      .post(`/api/tenancies/${tenancy.id}/invite`)
      .expect(201);
    const token2 = inv2.body.url.split('/l/')[1];

    assert.notEqual(token1, token2);

    // Verify in database: row 1 is revoked, row 2 is active
    const rowsRes = await pool.query(
      `SELECT token_hash, revoked_at FROM invites WHERE tenancy_id = $1 ORDER BY created_at ASC`,
      [tenancy.id]
    );
    assert.equal(rowsRes.rowCount, 2);
    assert.equal(rowsRes.rows[0].token_hash, hashToken(token1));
    assert.ok(rowsRes.rows[0].revoked_at !== null);
    assert.equal(rowsRes.rows[1].token_hash, hashToken(token2));
    assert.equal(rowsRes.rows[1].revoked_at, null);

    // Verify timeline events recorded: invite_created, invite_revoked, invite_created
    const eventsRes = await agent
      .get(`/api/tenancies/${tenancy.id}/events`)
      .expect(200);
    const inviteEvents = eventsRes.body.filter((e) =>
      e.type.startsWith('invite_')
    );
    assert.equal(inviteEvents.length, 3);
    assert.equal(inviteEvents[0].type, 'invite_created');
    assert.equal(inviteEvents[1].type, 'invite_revoked');
    assert.equal(inviteEvents[2].type, 'invite_created');
  });

  it('DELETE /api/tenancies/:id/invite revokes the active invite (returns 204)', async () => {
    const { agent } = await createRegisteredAgent('Delete Invite Tester');
    const tenancy = await createTenancy(agent);

    await agent.post(`/api/tenancies/${tenancy.id}/invite`).expect(201);

    await agent.delete(`/api/tenancies/${tenancy.id}/invite`).expect(204);

    const dbRes = await pool.query(
      `SELECT revoked_at FROM invites WHERE tenancy_id = $1`,
      [tenancy.id]
    );
    assert.equal(dbRes.rowCount, 1);
    assert.ok(dbRes.rows[0].revoked_at !== null);

    // GET tenancy shows active: false
    const getTenancy = await agent
      .get(`/api/tenancies/${tenancy.id}`)
      .expect(200);
    assert.equal(getTenancy.body.invite.active, false);

    // Second DELETE returns 204 without error
    await agent.delete(`/api/tenancies/${tenancy.id}/invite`).expect(204);
  });

  it('two simultaneous POST invite calls leave exactly one active row and one working invite', async () => {
    const { agent } = await createRegisteredAgent('Race Invite Tester');
    const tenancy = await createTenancy(agent);

    const [res1, res2] = await Promise.all([
      agent.post(`/api/tenancies/${tenancy.id}/invite`),
      agent.post(`/api/tenancies/${tenancy.id}/invite`),
    ]);

    assert.equal(res1.status, 201);
    assert.equal(res2.status, 201);

    // Check partial unique index constraint: exactly one active row (revoked_at IS NULL)
    const activeRes = await pool.query(
      `SELECT * FROM invites WHERE tenancy_id = $1 AND revoked_at IS NULL`,
      [tenancy.id]
    );
    assert.equal(activeRes.rowCount, 1);
  });

  it('another user cannot create or revoke an invite for my tenancy (IDOR 404)', async () => {
    const userA = await createRegisteredAgent('User A');
    const userB = await createRegisteredAgent('User B');
    const tenancyA = await createTenancy(userA.agent);

    await userB.agent.post(`/api/tenancies/${tenancyA.id}/invite`).expect(404);

    await userB.agent
      .delete(`/api/tenancies/${tenancyA.id}/invite`)
      .expect(404);

    const fakeId = crypto.randomUUID();
    await userA.agent.post(`/api/tenancies/${fakeId}/invite`).expect(404);
    await userA.agent.delete(`/api/tenancies/${fakeId}/invite`).expect(404);
  });
});
