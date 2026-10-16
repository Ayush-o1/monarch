import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app, { createApp } from '../../src/app.js';
import { pool } from '../../src/db/pool.js';

describe('Health and API routing', () => {
  after(async () => {
    await pool.end();
  });
  it('GET /api/health returns 200 { status: "ok" } when database is up', async () => {
    const res = await request(app).get('/api/health').expect(200);

    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('GET /api/health returns 503 when database is unreachable', async () => {
    const unreachablePool = {
      query: async () => {
        throw new Error('Connection refused');
      },
    };
    const brokenApp = createApp({ pool: unreachablePool });
    const res = await request(brokenApp).get('/api/health').expect(503);

    assert.equal(typeof res.body.error, 'object');
    assert.equal(res.body.error.code, 'DATABASE_UNAVAILABLE');
    assert.match(res.body.error.message, /database is unreachable/i);
    assert.deepEqual(res.body.error.details, {});
  });

  it('GET /api/nonexistent returns 404 in standard error shape', async () => {
    const res = await request(app).get('/api/nonexistent').expect(404);

    assert.equal(typeof res.body.error, 'object');
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.match(res.body.error.message, /not found/i);
    assert.deepEqual(res.body.error.details, {});
  });
});
