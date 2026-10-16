import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { LocalStorage } from '../../src/lib/storage/local.js';

describe('Media API, Storage, and Trigger Locking', () => {
  let app;
  let tmpUploadDir;
  let storage;

  before(async () => {
    await ensureTestDb();

    tmpUploadDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'monarch-media-test-')
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
    return `media_test_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
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

  async function createTenancyWithItem(
    agent,
    room = 'Kitchen',
    itemName = 'Oven'
  ) {
    const tenancyRes = await agent
      .post('/api/tenancies')
      .send({
        property_label: `Prop ${Date.now()}`,
        deposit_paise: 5000000,
      })
      .expect(201);

    const inspectionId = tenancyRes.body.inspections.moveIn.id;

    const itemRes = await agent
      .post(`/api/inspections/${inspectionId}/items`)
      .send({ room, name: itemName, condition: 'good' })
      .expect(201);

    return {
      tenancyId: tenancyRes.body.id,
      inspectionId,
      itemId: itemRes.body.id,
    };
  }

  async function makeTestImage({
    width = 100,
    height = 100,
    format = 'jpeg',
    color = { r: 255, g: 0, b: 0 },
    withExif = false,
  } = {}) {
    let pipeline = sharp({
      create: {
        width,
        height,
        channels: 3,
        background: color,
      },
    });

    if (withExif) {
      pipeline = pipeline.withExif({
        IFD0: {
          Make: 'TestCamera',
          Model: 'TestModel',
        },
      });
    }

    if (format === 'png') {
      return pipeline.png().toBuffer();
    }
    if (format === 'webp') {
      return pipeline.webp().toBuffer();
    }
    return pipeline.jpeg().toBuffer();
  }

  it('valid PNG and JPEG upload gives 201; GET returns image/jpeg and bytes decode no larger than 1600px', async () => {
    const { agent } = await createRegisteredAgent('Valid Upload Tester');
    const { itemId } = await createTenancyWithItem(agent);

    // 1. Upload valid PNG
    const pngBuffer = await makeTestImage({
      width: 200,
      height: 150,
      format: 'png',
      color: { r: 0, g: 255, b: 0 },
    });

    const pngRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', pngBuffer, 'photo.png')
      .expect(201);

    assert.ok(pngRes.body.id);
    assert.equal(pngRes.body.itemId, itemId);
    assert.ok(pngRes.body.sizeBytes > 0);
    assert.ok(pngRes.body.uploadedAt);
    assert.equal(
      pngRes.body.storage_key,
      undefined,
      'Never return storage_key'
    );

    // GET media for PNG (should be converted to image/jpeg)
    const pngGet = await agent
      .get(`/api/media/${pngRes.body.id}`)
      .expect(200)
      .expect('Content-Type', 'image/jpeg');

    const pngMeta = await sharp(pngGet.body).metadata();
    assert.equal(pngMeta.format, 'jpeg');
    assert.ok(pngMeta.width <= 1600);
    assert.ok(pngMeta.height <= 1600);

    // 2. Upload large JPEG (2000x1800)
    const largeJpegBuffer = await makeTestImage({
      width: 2000,
      height: 1800,
      format: 'jpeg',
      color: { r: 10, g: 20, b: 30 },
    });

    const jpegRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', largeJpegBuffer, 'large.jpg')
      .expect(201);

    const jpegGet = await agent
      .get(`/api/media/${jpegRes.body.id}`)
      .expect(200)
      .expect('Content-Type', 'image/jpeg');

    const jpegMeta = await sharp(jpegGet.body).metadata();
    assert.equal(jpegMeta.format, 'jpeg');
    assert.ok(
      jpegMeta.width <= 1600,
      `Expected width <= 1600, got ${jpegMeta.width}`
    );
    assert.ok(
      jpegMeta.height <= 1600,
      `Expected height <= 1600, got ${jpegMeta.height}`
    );
  });

  it('a text file named photo.jpg gives 415; a truncated JPEG gives 415; a file over size limit gives 413; wrong field name gives 400; no file gives 400', async () => {
    const { agent } = await createRegisteredAgent('Validation Error Tester');
    const { itemId } = await createTenancyWithItem(agent);

    // 1. Text file named photo.jpg -> 415
    const textRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach(
        'photo',
        Buffer.from('Hello world this is not an image'),
        'photo.jpg'
      )
      .expect(415);
    assert.equal(textRes.body.error.code, 'UNSUPPORTED_MEDIA');

    // 2. Truncated JPEG -> 415
    const validJpeg = await makeTestImage({ width: 100, height: 100 });
    const truncated = validJpeg.subarray(0, 20);
    const truncRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', truncated, 'corrupt.jpg')
      .expect(415);
    assert.equal(truncRes.body.error.code, 'UNSUPPORTED_MEDIA');

    // 3. File over size limit -> 413 (using custom app with small limit)
    const smallLimitApp = createApp({
      pool,
      storage,
      maxUploadMb: 0.0001, // ~100 bytes
      authLimiter: (_req, _res, next) => next(),
      mediaLimiter: (_req, _res, next) => next(),
    });
    const smallLimitAgent = request.agent(smallLimitApp);
    const { user } = await createRegisteredAgent('Small Limit User');
    // Login with smallLimitAgent
    await smallLimitAgent
      .post('/api/auth/login')
      .send({ email: user.email, password: 'password1234' })
      .expect(200);

    const overLimitRes = await smallLimitAgent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', validJpeg, 'photo.jpg')
      .expect(413);
    assert.equal(overLimitRes.body.error.code, 'FILE_TOO_LARGE');

    // 4. Wrong field name -> 400
    const wrongFieldRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('image', validJpeg, 'photo.jpg')
      .expect(400);
    assert.equal(wrongFieldRes.body.error.code, 'VALIDATION_ERROR');

    // 5. No file attached -> 400
    const noFileRes = await agent
      .post(`/api/items/${itemId}/media`)
      .expect(400);
    assert.equal(noFileRes.body.error.code, 'VALIDATION_ERROR');
  });

  it('9th photo gives 422; same image twice gives 409 DUPLICATE_PHOTO and leaves no orphan file; concurrency tests on limits', async () => {
    const { agent } = await createRegisteredAgent('Photo Limit Tester');
    const { itemId } = await createTenancyWithItem(agent);

    // Upload 8 distinct photos
    const photoIds = [];
    for (let i = 0; i < 8; i++) {
      const imgBuffer = await makeTestImage({
        width: 100 + i,
        height: 100,
        color: { r: i * 20, g: 100, b: 150 },
      });
      const res = await agent
        .post(`/api/items/${itemId}/media`)
        .attach('photo', imgBuffer, `photo_${i}.jpg`)
        .expect(201);
      photoIds.push(res.body.id);
    }
    assert.equal(photoIds.length, 8);

    // 1. Attempt 9th photo -> 422 TOO_MANY_PHOTOS
    const photo9 = await makeTestImage({
      width: 150,
      height: 150,
      color: { r: 250, g: 50, b: 50 },
    });
    const res9 = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', photo9, 'photo_9.jpg')
      .expect(422);
    assert.equal(res9.body.error.code, 'TOO_MANY_PHOTOS');

    // Concurrency test 1: 8 existing plus two simultaneous uploads give exactly zero successes
    const imgA = await makeTestImage({
      width: 160,
      height: 160,
      color: { r: 1, g: 2, b: 3 },
    });
    const imgB = await makeTestImage({
      width: 170,
      height: 170,
      color: { r: 4, g: 5, b: 6 },
    });
    const [sim8A, sim8B] = await Promise.all([
      agent
        .post(`/api/items/${itemId}/media`)
        .attach('photo', imgA, 'simA.jpg'),
      agent
        .post(`/api/items/${itemId}/media`)
        .attach('photo', imgB, 'simB.jpg'),
    ]);
    assert.equal(sim8A.status, 422);
    assert.equal(sim8B.status, 422);

    // 2. Duplicate photo test on a new item:
    const { itemId: dupItemId } = await createTenancyWithItem(
      agent,
      'Living Room',
      'Sofa'
    );
    const dupImage = await makeTestImage({
      width: 120,
      height: 120,
      color: { r: 12, g: 34, b: 56 },
    });

    // Count files in tmpUploadDir before
    const getFileCount = () => {
      let count = 0;
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(dir, entry.name));
          else count++;
        }
      };
      walk(tmpUploadDir);
      return count;
    };

    // First upload of dupImage
    await agent
      .post(`/api/items/${dupItemId}/media`)
      .attach('photo', dupImage, 'test.jpg')
      .expect(201);

    const countAfterFirst = getFileCount();

    // Second upload of identical dupImage -> 409 DUPLICATE_PHOTO
    const dupRes = await agent
      .post(`/api/items/${dupItemId}/media`)
      .attach('photo', dupImage, 'test.jpg')
      .expect(409);
    assert.equal(dupRes.body.error.code, 'DUPLICATE_PHOTO');

    // Check no orphan file left behind
    const countAfterSecond = getFileCount();
    assert.equal(
      countAfterSecond,
      countAfterFirst,
      'No orphan file should be left after duplicate photo rejection'
    );

    // Concurrency test 2: 7 existing plus two simultaneous uploads of different images give exactly one 201 and one 422
    const { itemId: concItemId } = await createTenancyWithItem(
      agent,
      'Bedroom',
      'Bed'
    );
    for (let i = 0; i < 7; i++) {
      const buf = await makeTestImage({
        width: 100 + i,
        height: 100,
        color: { r: i * 30, g: 20, b: 80 },
      });
      await agent
        .post(`/api/items/${concItemId}/media`)
        .attach('photo', buf, `photo_${i}.jpg`)
        .expect(201);
    }

    const concImg1 = await makeTestImage({
      width: 180,
      height: 180,
      color: { r: 88, g: 77, b: 66 },
    });
    const concImg2 = await makeTestImage({
      width: 190,
      height: 190,
      color: { r: 99, g: 11, b: 22 },
    });

    const [concRes1, concRes2] = await Promise.all([
      agent
        .post(`/api/items/${concItemId}/media`)
        .attach('photo', concImg1, 'c1.jpg'),
      agent
        .post(`/api/items/${concItemId}/media`)
        .attach('photo', concImg2, 'c2.jpg'),
    ]);

    const statuses = [concRes1.status, concRes2.status].sort();
    assert.deepEqual(statuses, [201, 422]);
  });

  it("another user's item upload, media GET and media DELETE give 404", async () => {
    const userA = await createRegisteredAgent('User A');
    const userB = await createRegisteredAgent('User B');

    const { itemId } = await createTenancyWithItem(userA.agent);
    const imgBuffer = await makeTestImage();

    // User A uploads media
    const uploadRes = await userA.agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', imgBuffer, 'photo.jpg')
      .expect(201);
    const mediaId = uploadRes.body.id;

    // User B tries to upload to User A's item -> 404
    await userB.agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', imgBuffer, 'photo.jpg')
      .expect(404);

    // User B tries to GET User A's media -> 404
    await userB.agent.get(`/api/media/${mediaId}`).expect(404);

    // User B tries to DELETE User A's media -> 404
    await userB.agent.delete(`/api/media/${mediaId}`).expect(404);

    // Malformed uuid in media path gives 404
    await userA.agent.get('/api/media/not-a-uuid').expect(404);
    await userA.agent.delete('/api/media/not-a-uuid').expect(404);
    await userA.agent.post('/api/items/not-a-uuid/media').expect(404);
  });

  it('EXIF: build a JPEG that has EXIF and assert the stored image has no exif metadata', async () => {
    const { agent } = await createRegisteredAgent('EXIF Tester');
    const { itemId } = await createTenancyWithItem(agent);

    const exifImageBuffer = await makeTestImage({ withExif: true });
    const originalMeta = await sharp(exifImageBuffer).metadata();
    assert.ok(originalMeta.exif, 'Test image should contain EXIF metadata');

    const uploadRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', exifImageBuffer, 'photo_exif.jpg')
      .expect(201);

    const getRes = await agent
      .get(`/api/media/${uploadRes.body.id}`)
      .expect(200);

    const storedMeta = await sharp(getRes.body).metadata();
    assert.equal(
      storedMeta.exif,
      undefined,
      'Stored image must have stripped EXIF metadata'
    );
  });

  it('inspection status submitted via raw SQL: upload and delete give 409 INSPECTION_LOCKED; raw SQL insert/update/delete fail with LOCKED:', async () => {
    const { agent } = await createRegisteredAgent('Locking Media Tester');
    const { inspectionId, itemId } = await createTenancyWithItem(agent);

    // Upload photo while draft
    const imgBuffer = await makeTestImage();
    const uploadRes = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', imgBuffer, 'item_photo.jpg')
      .expect(201);
    const mediaId = uploadRes.body.id;

    // Set inspection to submitted via raw SQL
    await pool.query(
      `UPDATE inspections SET status = 'submitted' WHERE id = $1`,
      [inspectionId]
    );

    // 1. API upload gives 409 INSPECTION_LOCKED
    const lockedUpload = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', await makeTestImage({ width: 111 }), 'photo2.jpg')
      .expect(409);
    assert.equal(lockedUpload.body.error.code, 'INSPECTION_LOCKED');

    // 2. API delete gives 409 INSPECTION_LOCKED
    const lockedDelete = await agent
      .delete(`/api/media/${mediaId}`)
      .expect(409);
    assert.equal(lockedDelete.body.error.code, 'INSPECTION_LOCKED');

    // 3. Raw SQL INSERT fails with LOCKED:
    await assert.rejects(async () => {
      await pool.query(
        `INSERT INTO media (item_id, storage_key, sha256, mime, size_bytes)
         VALUES ($1, 'raw_sql_key', $2, 'image/jpeg', 100)`,
        [itemId, crypto.randomBytes(32).toString('hex')]
      );
    }, /LOCKED: parent inspection is not in draft status/);

    // 4. Raw SQL UPDATE fails with LOCKED:
    await assert.rejects(async () => {
      await pool.query(`UPDATE media SET size_bytes = 200 WHERE id = $1`, [
        mediaId,
      ]);
    }, /LOCKED: parent inspection is not in draft status/);

    // 5. Raw SQL DELETE fails with LOCKED:
    await assert.rejects(async () => {
      await pool.query(`DELETE FROM media WHERE id = $1`, [mediaId]);
    }, /LOCKED: parent inspection is not in draft status/);

    // Restore inspection to draft
    await pool.query(`UPDATE inspections SET status = 'draft' WHERE id = $1`, [
      inspectionId,
    ]);

    // 6. Raw SQL update of item_id fails with immutable
    const { itemId: otherItemId } = await createTenancyWithItem(
      agent,
      'Bath',
      'Sink'
    );
    await assert.rejects(async () => {
      await pool.query(`UPDATE media SET item_id = $1 WHERE id = $2`, [
        otherItemId,
        mediaId,
      ]);
    }, /LOCKED: media item_id is immutable/);
  });

  it('deleting an item removes its media rows and its files from disk', async () => {
    const { agent } = await createRegisteredAgent('Item Cascade Tester');
    const { inspectionId, itemId } = await createTenancyWithItem(agent);

    const img1 = await makeTestImage({ width: 101 });
    const img2 = await makeTestImage({ width: 102 });

    const m1 = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', img1, 'photo1.jpg')
      .expect(201);

    const m2 = await agent
      .post(`/api/items/${itemId}/media`)
      .attach('photo', img2, 'photo2.jpg')
      .expect(201);

    // Verify GET /api/inspections/:id includes media in item
    const inspGet = await agent
      .get(`/api/inspections/${inspectionId}`)
      .expect(200);

    const item = inspGet.body.items.find((it) => it.id === itemId);
    assert.ok(item);
    assert.equal(item.media.length, 2);
    assert.equal(item.media[0].id, m1.body.id);
    assert.equal(item.media[1].id, m2.body.id);

    // Verify media files exist on disk before deleting item
    const mediaRows = await pool.query(
      `SELECT storage_key FROM media WHERE item_id = $1`,
      [itemId]
    );
    assert.equal(mediaRows.rowCount, 2);
    for (const row of mediaRows.rows) {
      assert.ok(
        fs.existsSync(path.resolve(tmpUploadDir, row.storage_key)),
        `File ${row.storage_key} should exist before delete`
      );
    }

    // Delete item via API
    await agent.delete(`/api/items/${itemId}`).expect(200);

    // Verify media rows deleted in database
    const remainingRows = await pool.query(
      `SELECT * FROM media WHERE item_id = $1`,
      [itemId]
    );
    assert.equal(remainingRows.rowCount, 0);

    // Verify media files deleted from disk
    for (const row of mediaRows.rows) {
      assert.equal(
        fs.existsSync(path.resolve(tmpUploadDir, row.storage_key)),
        false,
        `File ${row.storage_key} should be removed from disk`
      );
    }
  });
});
