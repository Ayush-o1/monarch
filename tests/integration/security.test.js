import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import sharp from 'sharp';
import rateLimit from 'express-rate-limit';
import { createApp } from '../../src/app.js';
import { pool, ownerPool, ensureTestDb } from '../helpers/db.js';
import { generateToken, hashToken } from '../../src/lib/tokens.js';
import { LocalStorage } from '../../src/lib/storage/local.js';

describe('Security Hardening & Ownership Verification', () => {
  let app;
  let tmpUploadDir;
  let storage;
  let aliceAgent;
  let bobAgent;
  let unauthAgent;

  let aliceTenancyId;
  let bobTenancyId;

  let aliceMoveInId;
  let aliceMoveOutId;
  let bobMoveInId;

  let aliceItemId;
  let bobItemId;

  let aliceMediaId;
  let bobMediaId;

  let aliceInviteToken;
  let bobInviteToken;

  let aliceDeductionId;
  let bobDeductionId;

  let sampleJpg;

  before(async () => {
    await ensureTestDb();

    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-security-test-')
    );
    storage = new LocalStorage(tmpUploadDir);

    app = createApp({
      pool,
      storage,
      authLimiter: (_req, _res, next) => next(),
      mediaLimiter: (_req, _res, next) => next(),
      landlordLimiter: (_req, _res, next) => next(),
    });

    sampleJpg = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .jpeg()
      .toBuffer();

    unauthAgent = request.agent(app);

    // Register Alice
    aliceAgent = request.agent(app);
    const aliceEmail = `alice_${Date.now()}@example.com`;
    await aliceAgent
      .post('/api/auth/register')
      .send({
        name: 'Alice Tenant',
        email: aliceEmail,
        password: 'password1234',
      })
      .expect(201);

    // Register Bob
    bobAgent = request.agent(app);
    const bobEmail = `bob_${Date.now()}@example.com`;
    await bobAgent
      .post('/api/auth/register')
      .send({ name: 'Bob Tenant', email: bobEmail, password: 'password1234' })
      .expect(201);

    // 1. Setup Alice's Tenancy and Resources
    const aliceTRes = await aliceAgent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Alice Flat 101',
        depositPaise: 5000000,
        refundWindowDays: 14,
      })
      .expect(201);
    aliceTenancyId = aliceTRes.body.id;
    aliceMoveInId = aliceTRes.body.inspections.moveIn.id;

    // Add item to Alice's inspection
    const aliceItemRes = await aliceAgent
      .post(`/api/inspections/${aliceMoveInId}/items`)
      .send({ room: 'Living Room', name: 'Sofa', condition: 'good' })
      .expect(201);
    aliceItemId = aliceItemRes.body.id;

    // Upload photo to Alice's item
    const aliceMediaRes = await aliceAgent
      .post(`/api/items/${aliceItemId}/media`)
      .attach('photo', sampleJpg, 'sofa.jpg')
      .expect(201);
    aliceMediaId = aliceMediaRes.body.id;

    // Create landlord invite for Alice
    const aliceInviteRes = await aliceAgent
      .post(`/api/tenancies/${aliceTenancyId}/invite`)
      .expect(201);
    aliceInviteToken = aliceInviteRes.body.url.split('/l/')[1];

    // Submit Alice move-in
    await aliceAgent
      .post(`/api/inspections/${aliceMoveInId}/submit`)
      .expect(200);

    // Landlord acknowledges move-in
    await request(app)
      .post(
        `/api/landlord/${aliceInviteToken}/inspections/${aliceMoveInId}/acknowledge`
      )
      .send({ name: 'Landlord Smith' })
      .expect(200);

    // Alice starts move-out
    const aliceMoveOutRes = await aliceAgent
      .post(`/api/tenancies/${aliceTenancyId}/move-out`)
      .expect(201);
    aliceMoveOutId = aliceMoveOutRes.body.inspection.id;

    // Fetch cloned move-out items and set condition so move-out can be submitted
    const aliceMoveOutItems = await aliceAgent
      .get(`/api/inspections/${aliceMoveOutId}`)
      .expect(200);
    for (const item of aliceMoveOutItems.body.items) {
      await aliceAgent
        .patch(`/api/items/${item.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }

    // Submit Alice move-out
    await aliceAgent
      .post(`/api/inspections/${aliceMoveOutId}/submit`)
      .expect(200);

    // Landlord proposes deduction on Alice's tenancy
    const aliceDedRes = await request(app)
      .post(`/api/landlord/${aliceInviteToken}/deductions`)
      .send({
        name: 'Landlord Smith',
        description: 'Clean sofa upholstery',
        amountPaise: 150000,
      })
      .expect(201);
    aliceDeductionId = aliceDedRes.body.line.id;

    // 2. Setup Bob's Tenancy and Resources
    const bobTRes = await bobAgent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Bob Flat 202',
        depositPaise: 6000000,
      })
      .expect(201);
    bobTenancyId = bobTRes.body.id;
    bobMoveInId = bobTRes.body.inspections.moveIn.id;

    const bobItemRes = await bobAgent
      .post(`/api/inspections/${bobMoveInId}/items`)
      .send({ room: 'Kitchen', name: 'Microwave', condition: 'good' })
      .expect(201);
    bobItemId = bobItemRes.body.id;

    const bobMediaRes = await bobAgent
      .post(`/api/items/${bobItemId}/media`)
      .attach('photo', sampleJpg, 'microwave.jpg')
      .expect(201);
    bobMediaId = bobMediaRes.body.id;

    const bobInviteRes = await bobAgent
      .post(`/api/tenancies/${bobTenancyId}/invite`)
      .expect(201);
    bobInviteToken = bobInviteRes.body.url.split('/l/')[1];

    await bobAgent.post(`/api/inspections/${bobMoveInId}/submit`).expect(200);
    await request(app)
      .post(
        `/api/landlord/${bobInviteToken}/inspections/${bobMoveInId}/acknowledge`
      )
      .send({ name: 'Landlord Bob' })
      .expect(200);

    const bobMoveOutRes = await bobAgent
      .post(`/api/tenancies/${bobTenancyId}/move-out`)
      .expect(201);
    const bobMoveOutId = bobMoveOutRes.body.inspection.id;

    const bobMoveOutItems = await bobAgent
      .get(`/api/inspections/${bobMoveOutId}`)
      .expect(200);
    for (const item of bobMoveOutItems.body.items) {
      await bobAgent
        .patch(`/api/items/${item.id}`)
        .send({ condition: 'good' })
        .expect(200);
    }

    await bobAgent.post(`/api/inspections/${bobMoveOutId}/submit`).expect(200);

    const bobDedRes = await request(app)
      .post(`/api/landlord/${bobInviteToken}/deductions`)
      .send({
        name: 'Landlord Bob',
        description: 'Microwave cleaning',
        amountPaise: 50000,
      })
      .expect(201);
    bobDeductionId = bobDedRes.body.line.id;
  });

  after(async () => {
    await pool.end();
    await ownerPool.end();
    if (tmpUploadDir && fs.existsSync(tmpUploadDir)) {
      fs.rmSync(tmpUploadDir, { recursive: true, force: true });
    }
  });

  // Table of all 21 tenant-session routes in the API contract
  const tenantSessionRoutes = [
    {
      name: 'GET /api/me',
      method: 'get',
      isResource: false,
      getPath: () => '/api/me',
    },
    {
      name: 'GET /api/tenancies',
      method: 'get',
      isResource: false,
      getPath: () => '/api/tenancies',
    },
    {
      name: 'POST /api/tenancies',
      method: 'post',
      isResource: false,
      getPath: () => '/api/tenancies',
      body: { propertyLabel: 'Another Tenancy', depositPaise: 4000000 },
    },
    {
      name: 'GET /api/tenancies/:id',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'GET /api/tenancies/:id/events',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/events`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'POST /api/tenancies/:id/invite',
      method: 'post',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/invite`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'DELETE /api/tenancies/:id/invite',
      method: 'delete',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/invite`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'POST /api/tenancies/:id/move-out',
      method: 'post',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/move-out`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'GET /api/tenancies/:id/comparison',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/comparison`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'GET /api/tenancies/:id/settlement',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/settlement`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'POST /api/tenancies/:id/close',
      method: 'post',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/close`,
      getId: () => aliceTenancyId,
      body: { acknowledgeUnresolved: true },
    },
    {
      name: 'GET /api/tenancies/:id/report.pdf',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/tenancies/${id}/report.pdf`,
      getId: () => aliceTenancyId,
    },
    {
      name: 'GET /api/inspections/:id',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/inspections/${id}`,
      getId: () => aliceMoveInId,
    },
    {
      name: 'POST /api/inspections/:id/submit',
      method: 'post',
      isResource: true,
      getPath: (id) => `/api/inspections/${id}/submit`,
      getId: () => aliceMoveInId,
    },
    {
      name: 'POST /api/inspections/:id/items',
      method: 'post',
      isResource: true,
      getPath: (id) => `/api/inspections/${id}/items`,
      getId: () => aliceMoveInId,
      body: { room: 'Hall', name: 'Curtains', condition: 'good' },
    },
    {
      name: 'PATCH /api/items/:id',
      method: 'patch',
      isResource: true,
      getPath: (id) => `/api/items/${id}`,
      getId: () => aliceItemId,
      body: { condition: 'minor_wear' },
    },
    {
      name: 'DELETE /api/items/:id',
      method: 'delete',
      isResource: true,
      getPath: (id) => `/api/items/${id}`,
      getId: () => aliceItemId,
    },
    {
      name: 'POST /api/items/:id/media',
      method: 'post',
      isResource: true,
      isUpload: true,
      getPath: (id) => `/api/items/${id}/media`,
      getId: () => aliceItemId,
    },
    {
      name: 'GET /api/media/:id',
      method: 'get',
      isResource: true,
      getPath: (id) => `/api/media/${id}`,
      getId: () => aliceMediaId,
    },
    {
      name: 'DELETE /api/media/:id',
      method: 'delete',
      isResource: true,
      getPath: (id) => `/api/media/${id}`,
      getId: () => aliceMediaId,
    },
    {
      name: 'PATCH /api/deductions/:id',
      method: 'patch',
      isResource: true,
      getPath: (id) => `/api/deductions/${id}`,
      getId: () => aliceDeductionId,
      body: { action: 'dispute', note: 'Not caused by tenant' },
    },
  ];

  describe('Tenant Session Routes Table-Driven Authorization and Isolation', () => {
    for (const route of tenantSessionRoutes) {
      describe(`Route: ${route.name}`, () => {
        it('without session returns 401 UNAUTHORIZED', async () => {
          const targetPath = route.isResource
            ? route.getPath(route.getId())
            : route.getPath();
          let req = unauthAgent[route.method](targetPath);
          if (route.isUpload) {
            req = req.attach('photo', sampleJpg, 'test.jpg');
          } else if (route.body) {
            req = req.send(route.body);
          }
          const res = await req;
          assert.equal(
            res.status,
            401,
            `Expected 401 for unauthenticated ${route.name}, got ${res.status}`
          );
          assert.equal(res.body.error?.code, 'UNAUTHORIZED');
        });

        if (route.isResource) {
          it("with a second user's session returns 404 (never 403, 200, 500)", async () => {
            const targetPath = route.getPath(route.getId()); // Bob requests Alice's resource
            let req = bobAgent[route.method](targetPath);
            if (route.isUpload) {
              req = req.attach('photo', sampleJpg, 'test.jpg');
            } else if (route.body) {
              req = req.send(route.body);
            }
            const res = await req;
            assert.equal(
              res.status,
              404,
              `Expected 404 for cross-user resource access on ${route.name}, got ${res.status}`
            );
            assert.notEqual(res.status, 403);
            assert.notEqual(res.status, 200);
            assert.notEqual(res.status, 500);
          });

          it('with malformed uuid returns 404 NOT_FOUND', async () => {
            const targetPath = route.getPath('malformed-uuid-12345');
            let req = aliceAgent[route.method](targetPath);
            if (route.isUpload) {
              req = req.attach('photo', sampleJpg, 'test.jpg');
            } else if (route.body) {
              req = req.send(route.body);
            }
            const res = await req;
            assert.equal(
              res.status,
              404,
              `Expected 404 for malformed UUID on ${route.name}, got ${res.status}`
            );
          });
        }
      });
    }
  });

  describe('Landlord Route Security & Isolation', () => {
    it('bogus token returns 404', async () => {
      // 1. Invalid token format (not 43 chars base64url)
      const resBadFormat = await request(app)
        .get('/api/landlord/shortToken/tenancy')
        .expect(404);
      assert.equal(resBadFormat.body.error?.code, 'INVALID_LINK');

      // 2. Valid format 43 chars, but not present in DB
      const nonexistentToken = generateToken();
      const resNotFound = await request(app)
        .get(`/api/landlord/${nonexistentToken}/tenancy`)
        .expect(404);
      assert.equal(resNotFound.body.error?.code, 'INVALID_LINK');
    });

    it('expired token returns 410 LINK_EXPIRED', async () => {
      const expT = await aliceAgent
        .post('/api/tenancies')
        .send({
          propertyLabel: 'Expired Invite Tenancy',
          depositPaise: 1000000,
        })
        .expect(201);

      const token = generateToken();
      const tokenHash = hashToken(token);

      await ownerPool.query(
        `INSERT INTO invites (tenancy_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() - INTERVAL '1 hour')`,
        [expT.body.id, tokenHash]
      );

      const res = await request(app)
        .get(`/api/landlord/${token}/tenancy`)
        .expect(410);
      assert.equal(res.body.error?.code, 'LINK_EXPIRED');
    });

    it('revoked token returns 410 LINK_REVOKED', async () => {
      const revT = await aliceAgent
        .post('/api/tenancies')
        .send({
          propertyLabel: 'Revoked Invite Tenancy',
          depositPaise: 1000000,
        })
        .expect(201);

      const token = generateToken();
      const tokenHash = hashToken(token);

      await ownerPool.query(
        `INSERT INTO invites (tenancy_id, token_hash, expires_at, revoked_at)
         VALUES ($1, $2, NOW() + INTERVAL '1 hour', NOW())`,
        [revT.body.id, tokenHash]
      );

      const res = await request(app)
        .get(`/api/landlord/${token}/tenancy`)
        .expect(410);
      assert.equal(res.body.error?.code, 'LINK_REVOKED');
    });

    it('token of tenancy A cannot touch resources of tenancy B (404)', async () => {
      // Token A trying to view Tenancy B's media
      const resMedia = await request(app)
        .get(`/api/landlord/${aliceInviteToken}/media/${bobMediaId}`)
        .expect(404);
      assert.equal(resMedia.body.error?.code, 'NOT_FOUND');

      // Token A trying to acknowledge Tenancy B's inspection
      const resAck = await request(app)
        .post(
          `/api/landlord/${aliceInviteToken}/inspections/${bobMoveInId}/acknowledge`
        )
        .send({ name: 'Cross Landlord' })
        .expect(404);
      assert.equal(resAck.body.error?.code, 'NOT_FOUND');

      // Token A trying to request changes on Tenancy B's inspection
      const resReqChanges = await request(app)
        .post(
          `/api/landlord/${aliceInviteToken}/inspections/${bobMoveInId}/request-changes`
        )
        .send({ name: 'Cross Landlord', note: 'Changes needed' })
        .expect(404);
      assert.equal(resReqChanges.body.error?.code, 'NOT_FOUND');

      // Token A trying to withdraw deduction line from Tenancy B
      const resWithdraw = await request(app)
        .post(
          `/api/landlord/${aliceInviteToken}/deductions/${bobDeductionId}/withdraw`
        )
        .send({ name: 'Cross Landlord' })
        .expect(404);
      assert.equal(resWithdraw.body.error?.code, 'NOT_FOUND');
    });
  });

  describe('Security Headers', () => {
    const endpoints = [
      { name: 'Root page /', path: '/' },
      { name: 'Login page /login.html', path: '/login.html' },
      {
        name: 'Landlord review page /l/:token',
        getPath: () => `/l/${aliceInviteToken}`,
      },
      { name: 'API health route /api/health', path: '/api/health' },
    ];

    for (const ep of endpoints) {
      it(`enforces CSP, Referrer-Policy, nosniff, and frame restrictions on ${ep.name}`, async () => {
        const target = ep.path || ep.getPath();
        const res = await request(app).get(target);

        // CSP
        const csp = res.headers['content-security-policy'];
        assert.ok(csp, `Missing CSP header on ${ep.name}`);
        assert.ok(
          csp.includes("default-src 'self'"),
          `CSP must contain default-src 'self' on ${ep.name}`
        );
        assert.ok(
          !csp.includes("'unsafe-inline'"),
          `CSP must not contain 'unsafe-inline' on ${ep.name}`
        );
        assert.ok(
          !csp.includes("'unsafe-eval'"),
          `CSP must not contain 'unsafe-eval' on ${ep.name}`
        );

        // Referrer-Policy
        assert.equal(res.headers['referrer-policy'], 'no-referrer');

        // X-Content-Type-Options
        assert.equal(res.headers['x-content-type-options'], 'nosniff');

        // X-Frame-Options or frame-ancestors none
        const frameAncestorsNone = csp.includes("frame-ancestors 'none'");
        const xFrameDeny =
          res.headers['x-frame-options'] === 'DENY' ||
          res.headers['x-frame-options'] === 'SAMEORIGIN';
        assert.ok(
          frameAncestorsNone || xFrameDeny,
          `Expected frame restriction (frame-ancestors 'none' or X-Frame-Options) on ${ep.name}`
        );
      });
    }

    it('enforces Cache-Control: no-store on landlord routes', async () => {
      const resPage = await request(app).get(`/l/${aliceInviteToken}`);
      assert.ok(resPage.headers['cache-control']?.includes('no-store'));

      const resApi = await request(app).get(
        `/api/landlord/${aliceInviteToken}/tenancy`
      );
      assert.ok(resApi.headers['cache-control']?.includes('no-store'));
    });

    it('enforces Cache-Control: private on media responses', async () => {
      const res = await aliceAgent.get(`/api/media/${aliceMediaId}`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['cache-control']?.includes('private'));
    });
  });

  describe('COOKIE_SECURE=true Behaviour', () => {
    it('sets Secure flag in Set-Cookie when cookieSecure is true and request is secure', async () => {
      const secureApp = createApp({
        pool,
        cookieSecure: true,
        authLimiter: (_req, _res, next) => next(),
      });

      const res = await request(secureApp)
        .post('/api/auth/register')
        .set('X-Forwarded-Proto', 'https')
        .send({
          name: 'Secure User',
          email: `secure_${Date.now()}@example.com`,
          password: 'password1234',
        })
        .expect(201);

      const setCookie = res.headers['set-cookie'];
      assert.ok(setCookie, 'Expected Set-Cookie header to be present');
      const cookieStr = Array.isArray(setCookie)
        ? setCookie.join('; ')
        : setCookie;
      assert.match(
        cookieStr,
        /;\s*Secure/i,
        'Expected Set-Cookie to contain Secure attribute'
      );
    });
  });

  describe('Rate Limiting Coverage Confirmation', () => {
    it('media upload rate limiter returns 429 when upload threshold is exceeded', async () => {
      const limitedApp = createApp({
        pool,
        storage,
        authLimiter: (_req, _res, next) => next(),
        mediaLimiter: rateLimit({
          windowMs: 60 * 1000,
          max: 2,
          standardHeaders: true,
          legacyHeaders: false,
          handler: (_req, _res, next) => {
            import('../../src/lib/errors.js').then(({ AppError }) => {
              next(
                new AppError(429, 'TOO_MANY_REQUESTS', 'Upload limit exceeded')
              );
            });
          },
        }),
      });

      const userAgent = request.agent(limitedApp);
      await userAgent
        .post('/api/auth/register')
        .send({
          name: 'Rate User',
          email: `rate_${Date.now()}@example.com`,
          password: 'password1234',
        })
        .expect(201);

      const tRes = await userAgent
        .post('/api/tenancies')
        .send({ propertyLabel: 'Rate Flat', depositPaise: 1000000 })
        .expect(201);
      const mId = tRes.body.inspections.moveIn.id;

      const itemRes = await userAgent
        .post(`/api/inspections/${mId}/items`)
        .send({ room: 'Hall', name: 'Chair', condition: 'good' })
        .expect(201);
      const itemId = itemRes.body.id;

      const p1 = await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 10, g: 10, b: 10 },
        },
      })
        .jpeg()
        .toBuffer();
      const p2 = await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 20, g: 20, b: 20 },
        },
      })
        .jpeg()
        .toBuffer();
      const p3 = await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 3,
          background: { r: 30, g: 30, b: 30 },
        },
      })
        .jpeg()
        .toBuffer();

      // 1st upload: OK
      await userAgent
        .post(`/api/items/${itemId}/media`)
        .attach('photo', p1, 'p1.jpg')
        .expect(201);
      // 2nd upload: OK
      await userAgent
        .post(`/api/items/${itemId}/media`)
        .attach('photo', p2, 'p2.jpg')
        .expect(201);
      // 3rd upload: 429
      const res3 = await userAgent
        .post(`/api/items/${itemId}/media`)
        .attach('photo', p3, 'p3.jpg');
      assert.equal(res3.status, 429);
      assert.equal(res3.body.error?.code, 'TOO_MANY_REQUESTS');
    });
  });
});
