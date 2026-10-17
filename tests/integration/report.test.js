import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { LocalStorage } from '../../src/lib/storage/local.js';

describe('Handover PDF Report API (Phase 9)', () => {
  let app;
  let tmpUploadDir;
  let storage;

  before(async () => {
    await ensureTestDb();

    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-report-test-')
    );
    storage = new LocalStorage(tmpUploadDir);

    app = createApp({
      pool,
      storage,
      reportCompress: false,
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
    return `report_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
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

  async function makeValidJpeg(width = 60, height = 60) {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 120, g: 140, b: 180 },
      },
    })
      .jpeg()
      .toBuffer();
  }

  async function getPdf(agent, url) {
    return await agent
      .get(url)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  }

  function extractPdfText(buf) {
    const str = buf.toString('latin1');
    return str.replace(/\[([^\]]+)\]\s*TJ/g, (_, inner) => {
      const parts = [];
      const hexRegex = /<([0-9a-fA-F]+)>/g;
      let m;
      while ((m = hexRegex.exec(inner)) !== null) {
        parts.push(Buffer.from(m[1], 'hex').toString('latin1'));
      }
      return parts.join('');
    });
  }

  it('a tenancy with no photos: 200, Content-Type application/pdf, body starts with %PDF-, Content-Disposition is an attachment with an ASCII filename', async () => {
    const { agent } = await createRegisteredAgent('Tenant No Photos');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Sunny Studio 101',
        depositPaise: 2500000,
        refundWindowDays: 14,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;

    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');

    const header = res.body.slice(0, 5).toString('latin1');
    assert.equal(header, '%PDF-');

    const disposition = res.headers['content-disposition'];
    assert.ok(disposition, 'Content-Disposition header should be present');
    assert.match(
      disposition,
      /^attachment;\s*filename="handover-sunny-studio-101-\d{4}-\d{2}-\d{2}\.pdf"$/
    );
    // Ensure filename is pure ASCII
    assert.ok(/^[\x20-\x7E]+$/.test(disposition));
  });

  it('a full flow tenancy: with compress false, contains label, deduction, Rs, footer, Worse, settlement wording; does NOT contain tenant email, invite token, storage key; embeds expected number of images', async () => {
    const { agent, email: tenantEmail } =
      await createRegisteredAgent('Full Flow Tenant');
    const propertyLabel = 'Rose Villa 404';

    // 1. Create tenancy
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: propertyLabel,
        depositPaise: 5000000,
        refundWindowDays: 30,
        address: '123 Palm Avenue, Indiranagar',
        landlordName: 'Mr. Landlord Sharma',
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const moveInId = tenancyRes.body.inspections.moveIn.id;

    // 2. Add two items to move-in
    // Item 1: Living Room - Sofa (good)
    const it1Res = await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Living Room', name: 'Sofa', condition: 'good' })
      .expect(201);
    const item1MoveInId = it1Res.body.id;

    // Item 2: Kitchen - Sink (good)
    const it2Res = await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Kitchen', name: 'Sink', condition: 'good' })
      .expect(201);
    const item2MoveInId = it2Res.body.id;

    // Upload photo to Item 1 on move-in
    const photo1Buf = await makeValidJpeg(80, 80);
    await agent
      .post(`/api/items/${item1MoveInId}/media`)
      .attach('photo', photo1Buf, 'sofa_movein.jpg')
      .expect(201);

    // Upload extra photo to Item 2 on move-in (this item remains "same" and unlinked, so this photo must NOT be included)
    const photo2Buf = await makeValidJpeg(80, 80);
    await agent
      .post(`/api/items/${item2MoveInId}/media`)
      .attach('photo', photo2Buf, 'sink_movein.jpg')
      .expect(201);

    // 3. Submit move-in
    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    // 4. Create landlord invite
    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const inviteToken = inviteRes.body.url.split('/l/')[1];

    // Acknowledge move-in as landlord
    await request(app)
      .post(`/api/landlord/${inviteToken}/inspections/${moveInId}/acknowledge`)
      .send({ name: 'Mr. Landlord Sharma' })
      .expect(200);

    // 5. Start move-out
    const moveOutRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = moveOutRes.body.inspection.id;

    // Get move-out items (cloned)
    const itemsRes = await pool.query(
      `SELECT id, room, name FROM inspection_items WHERE inspection_id = $1`,
      [moveOutId]
    );
    const moveOutItem1 = itemsRes.rows.find((i) => i.name === 'Sofa');
    const moveOutItem2 = itemsRes.rows.find((i) => i.name === 'Sink');

    // Update move-out Item 1 to damaged (worse)
    await agent
      .patch(`/api/items/${moveOutItem1.id}`)
      .send({ condition: 'damaged', note: 'Fabric torn on left armrest' })
      .expect(200);

    // Update move-out Item 2 to good (same)
    await agent
      .patch(`/api/items/${moveOutItem2.id}`)
      .send({ condition: 'good' })
      .expect(200);

    // Upload photo to Item 1 on move-out side
    const photo3Buf = await makeValidJpeg(80, 80);
    await agent
      .post(`/api/items/${moveOutItem1.id}/media`)
      .attach('photo', photo3Buf, 'sofa_moveout.jpg')
      .expect(201);

    // 6. Submit move-out
    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    // 7. Propose deduction linked to Item 1
    const deductionDescription = 'Repair damaged sofa fabric';
    await request(app)
      .post(`/api/landlord/${inviteToken}/deductions`)
      .send({
        name: 'Mr. Landlord Sharma',
        description: deductionDescription,
        amountPaise: 150000,
        itemId: moveOutItem1.id,
      })
      .expect(201);

    // Collect all storage keys generated in DB for this tenancy
    const mediaRows = await pool.query(
      `SELECT storage_key FROM media WHERE item_id IN ($1, $2, $3, $4)`,
      [item1MoveInId, item2MoveInId, moveOutItem1.id, moveOutItem2.id]
    );
    const allStorageKeys = mediaRows.rows.map((r) => r.storage_key);
    assert.ok(allStorageKeys.length >= 3, 'Should have at least 3 photos');

    // 8. Request PDF
    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');

    const bodyStr = extractPdfText(res.body);
    const rawBytes = res.body.toString('latin1');

    // Required content checks
    assert.ok(bodyStr.includes(propertyLabel), 'Must contain property label');
    assert.ok(
      bodyStr.includes(deductionDescription),
      'Must contain deduction description'
    );
    assert.ok(bodyStr.includes('Rs'), 'Must contain Rs currency prefix');
    assert.ok(
      bodyStr.includes(
        'Handover records what the parties entered and acknowledged. It is not legal advice.'
      ),
      'Must contain footer sentence'
    );
    assert.ok(
      bodyStr.includes('Worse'),
      'Must contain Worse comparison outcome'
    );
    assert.ok(
      bodyStr.includes('Settlement summary'),
      'Must contain Settlement summary'
    );
    assert.ok(
      bodyStr.includes('Deposit:'),
      'Must contain Deposit: in settlement'
    );
    assert.ok(
      bodyStr.includes('Accepted:'),
      'Must contain Accepted: in settlement'
    );
    assert.ok(
      bodyStr.includes('Awaiting:'),
      'Must contain Awaiting: in settlement'
    );
    assert.ok(
      bodyStr.includes('Disputed:'),
      'Must contain Disputed: in settlement'
    );
    assert.ok(
      bodyStr.includes('Unclaimed:'),
      'Must contain Unclaimed: in settlement'
    );

    // Secret / privacy assertions: must NOT contain tenant email, invite token, or storage keys
    assert.ok(
      !rawBytes.includes(tenantEmail) && !bodyStr.includes(tenantEmail),
      'Must NOT contain tenant email'
    );
    assert.ok(
      !rawBytes.includes(inviteToken) && !bodyStr.includes(inviteToken),
      'Must NOT contain raw invite token'
    );
    for (const key of allStorageKeys) {
      assert.ok(
        !rawBytes.includes(key) && !bodyStr.includes(key),
        `Must NOT contain storage key: ${key}`
      );
    }

    // Image count check:
    // Item 1 is worse and deduction linked: 1 move-in photo + 1 move-out photo = 2 photos.
    // Item 2 is 'same' and not deduction linked: its photo MUST NOT be included.
    const imageCount = (bodyStr.match(/\/Subtype\s*\/Image\b/g) || []).length;
    assert.equal(
      imageCount,
      2,
      `Expected exactly 2 embedded images, got ${imageCount}`
    );
  });

  it('an active tenancy (nothing submitted) still returns a valid PDF with Not yet recorded', async () => {
    const { agent } = await createRegisteredAgent('Active Tenant');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Empty Loft 7',
        depositPaise: 1000000,
        refundWindowDays: 7,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;

    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);

    const bodyStr = extractPdfText(res.body);
    assert.ok(
      bodyStr.includes('Not yet recorded'),
      'Active tenancy PDF must include "Not yet recorded"'
    );
  });

  it('a tenancy whose photo file was deleted from disk still returns 200 with Photo unavailable', async () => {
    const { agent } = await createRegisteredAgent('Deleted Photo Tenant');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Garden Flat 2B',
        depositPaise: 2000000,
        refundWindowDays: 14,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const moveInId = tenancyRes.body.inspections.moveIn.id;

    const itRes = await agent
      .post(`/api/inspections/${moveInId}/items`)
      .send({ room: 'Living Room', name: 'Mirror', condition: 'good' })
      .expect(201);

    const photoBuf = await makeValidJpeg(50, 50);
    await agent
      .post(`/api/items/${itRes.body.id}/media`)
      .attach('photo', photoBuf, 'mirror.jpg')
      .expect(201);

    await agent.post(`/api/inspections/${moveInId}/submit`).expect(200);

    const inviteRes = await agent
      .post(`/api/tenancies/${tenancyId}/invite`)
      .expect(201);
    const token = inviteRes.body.url.split('/l/')[1];

    await request(app)
      .post(`/api/landlord/${token}/inspections/${moveInId}/acknowledge`)
      .send({ name: 'Landlord' })
      .expect(200);

    const moveOutRes = await agent
      .post(`/api/tenancies/${tenancyId}/move-out`)
      .expect(201);
    const moveOutId = moveOutRes.body.inspection.id;

    const items = await pool.query(
      `SELECT id FROM inspection_items WHERE inspection_id = $1`,
      [moveOutId]
    );
    const outItemId = items.rows[0].id;

    await agent
      .patch(`/api/items/${outItemId}`)
      .send({ condition: 'damaged' })
      .expect(200);

    await agent.post(`/api/inspections/${moveOutId}/submit`).expect(200);

    // Delete all files in the tenancy upload folder to simulate missing disk files
    const tenancyUploadFolder = path.join(tmpUploadDir, tenancyId);
    if (fs.existsSync(tenancyUploadFolder)) {
      fs.rmSync(tenancyUploadFolder, { recursive: true, force: true });
    }

    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);

    const bodyStr = extractPdfText(res.body);
    assert.ok(
      bodyStr.includes('Photo unavailable'),
      'Must print "Photo unavailable" when image file is missing'
    );
  });

  it('a tenancy with 60 worse items with photos: at most 40 images are embedded and the more photos not shown line is present', async () => {
    const { agent } = await createRegisteredAgent('Many Worse Items Tenant');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Huge Mansion',
        depositPaise: 10000000,
        refundWindowDays: 30,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const moveInId = tenancyRes.body.inspections.moveIn.id;

    // Create 60 items directly in DB for speed
    const photoBuf = await makeValidJpeg(20, 20);
    const sharedPhotoKey = `${tenancyId}/shared-worse.jpg`;
    await storage.save(sharedPhotoKey, photoBuf);

    // Move-in items: condition 'good'
    const moveInItemIds = [];
    for (let i = 1; i <= 60; i++) {
      const room = `Room ${Math.ceil(i / 10)}`;
      const name = `Item ${i}`;
      const r = await pool.query(
        `INSERT INTO inspection_items (inspection_id, room, name, condition)
         VALUES ($1, $2, $3, 'good') RETURNING id`,
        [moveInId, room, name]
      );
      moveInItemIds.push(r.rows[0].id);
    }

    await pool.query(
      `UPDATE inspections SET status = 'submitted', submitted_at = now() WHERE id = $1`,
      [moveInId]
    );
    await pool.query(
      `UPDATE inspections SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by_name = 'Owner' WHERE id = $1`,
      [moveInId]
    );

    // Create move-out inspection as draft
    const outInspRes = await pool.query(
      `INSERT INTO inspections (tenancy_id, type, status)
       VALUES ($1, 'move_out', 'draft') RETURNING id`,
      [tenancyId]
    );
    const moveOutId = outInspRes.rows[0].id;

    // Move-out items: condition 'damaged' (worse) with 1 photo each
    for (let i = 1; i <= 60; i++) {
      const room = `Room ${Math.ceil(i / 10)}`;
      const name = `Item ${i}`;
      const itemRes = await pool.query(
        `INSERT INTO inspection_items (inspection_id, room, name, condition)
         VALUES ($1, $2, $3, 'damaged') RETURNING id`,
        [moveOutId, room, name]
      );
      const itemId = itemRes.rows[0].id;

      const photoKey = `${tenancyId}/worse-${i}.jpg`;
      await storage.save(photoKey, photoBuf);

      await pool.query(
        `INSERT INTO media (item_id, storage_key, sha256, mime, size_bytes)
         VALUES ($1, $2, 'dummy-sha', 'image/jpeg', $3)`,
        [itemId, photoKey, photoBuf.length]
      );
    }

    // Now submit move-out
    await pool.query(
      `UPDATE inspections SET status = 'submitted', submitted_at = now() WHERE id = $1`,
      [moveOutId]
    );

    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);

    const bodyStr = extractPdfText(res.body);
    const imageCount = (
      res.body.toString('latin1').match(/\/Subtype\s*\/Image\b/g) || []
    ).length;
    assert.equal(
      imageCount,
      40,
      `Expected at most 40 images embedded, got ${imageCount}`
    );
    assert.ok(
      bodyStr.includes('more photos not shown'),
      'Must contain "more photos not shown" note'
    );
    assert.ok(
      bodyStr.includes('20 more photos not shown'),
      'Must specifically say "20 more photos not shown"'
    );
  });

  it('a tenancy with about 100 items returns 200 (print the duration, assert only that it succeeds)', async () => {
    const { agent } = await createRegisteredAgent('100 Items Tenant');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Big Complex 100',
        depositPaise: 5000000,
        refundWindowDays: 14,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const moveInId = tenancyRes.body.inspections.moveIn.id;

    // Insert 100 items directly
    const itemValues = [];
    const params = [moveInId];
    for (let i = 1; i <= 100; i++) {
      const room = `Room ${Math.ceil(i / 10)}`;
      const name = `Fixture ${i}`;
      const offset = (i - 1) * 3 + 2;
      itemValues.push(`($1, $${offset}, $${offset + 1}, $${offset + 2})`);
      params.push(room, name, i % 2 === 0 ? 'good' : 'minor_wear');
    }
    await pool.query(
      `INSERT INTO inspection_items (inspection_id, room, name, condition) VALUES ${itemValues.join(', ')}`,
      params
    );

    const t0 = Date.now();
    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    const duration = Date.now() - t0;
    console.log(
      `[Performance] 100 items PDF report generated in ${duration}ms`
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.body.slice(0, 5).toString('latin1'), '%PDF-');
  });

  it('auth and validation: another user gives 404, malformed uuid gives 404, no session gives 401, landlord token cannot reach report.pdf', async () => {
    const { agent: agentA } = await createRegisteredAgent('User A');
    const { agent: agentB } = await createRegisteredAgent('User B');

    const tenancyRes = await agentA
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Private Property A',
        depositPaise: 1000000,
        refundWindowDays: 14,
      })
      .expect(201);
    const tenancyId = tenancyRes.body.id;

    // 1. Another user's tenancy gives 404
    const otherRes = await agentB.get(`/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(otherRes.status, 404);

    // 2. Malformed UUID gives 404
    const malformedRes = await agentA.get(
      '/api/tenancies/not-a-valid-uuid/report.pdf'
    );
    assert.equal(malformedRes.status, 404);

    // 3. No session gives 401
    const noSessionAgent = request(app);
    const noSessionRes = await noSessionAgent.get(
      `/api/tenancies/${tenancyId}/report.pdf`
    );
    assert.equal(noSessionRes.status, 401);

    // 4. Landlord token route gives 404
    const landlordRes = await request(app).get(
      '/api/landlord/any-token-here/report.pdf'
    );
    assert.equal(landlordRes.status, 404);
  });

  it('a tenancy whose names contain Kannada text, emoji and a rupee sign still produces a valid PDF (no exception)', async () => {
    const { agent } = await createRegisteredAgent('Kannada Tenant 👨‍💼');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'ಬೆಂಗಳೂರು ಅಪಾರ್ಟ್ಮೆಂಟ್ 🏠 ₹ 50,000',
        depositPaise: 5000000,
        refundWindowDays: 14,
        address: 'ಎಂ ಜಿ ರಸ್ತೆ, ಬೆಂಗಳೂರು 🌴',
        landlordName: 'ಶ್ರೀನಿವಾಸ್ ರಾವ್ 🤝',
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.equal(res.body.slice(0, 5).toString('latin1'), '%PDF-');
  });

  it('response headers: Cache-Control private, no-store and X-Content-Type-Options nosniff', async () => {
    const { agent } = await createRegisteredAgent('Header Test Tenant');
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Header Test Prop',
        depositPaise: 1000000,
        refundWindowDays: 14,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const res = await getPdf(agent, `/api/tenancies/${tenancyId}/report.pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'private, no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('GET report.pdf?compress=false on a default app returns a compressed PDF (the footer sentence does not appear in the plain bytes) and still returns 200', async () => {
    const defaultApp = createApp({
      pool,
      storage,
      authLimiter: (_req, _res, next) => next(),
      mediaLimiter: (_req, _res, next) => next(),
    });
    const defaultAgent = request.agent(defaultApp);
    const email = randomEmail();
    await defaultAgent
      .post('/api/auth/register')
      .send({
        name: 'Default Compress Tenant',
        email,
        password: 'password1234',
      })
      .expect(201);

    const tenancyRes = await defaultAgent
      .post('/api/tenancies')
      .send({
        propertyLabel: 'Default Compress Test Flat',
        depositPaise: 5000000,
        refundWindowDays: 14,
      })
      .expect(201);

    const tenancyId = tenancyRes.body.id;
    const res = await getPdf(
      defaultAgent,
      `/api/tenancies/${tenancyId}/report.pdf?compress=false`
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    const rawBytes = res.body.toString('latin1');
    assert.ok(
      !rawBytes.includes(
        'Handover records what the parties entered and acknowledged. It is not legal advice.'
      ),
      'Footer sentence must not appear in the plain bytes of compressed PDF'
    );
  });
});
