import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../../src/app.js';

describe('Health and API routing', () => {
  it('GET /api/health returns 200 { status: "ok" }', async () => {
    const res = await request(app).get('/api/health').expect(200);

    assert.deepEqual(res.body, { status: 'ok' });
  });

  it('GET /api/nonexistent returns 404 in standard error shape', async () => {
    const res = await request(app).get('/api/nonexistent').expect(404);

    assert.equal(typeof res.body.error, 'object');
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.match(res.body.error.message, /not found/i);
    assert.deepEqual(res.body.error.details, {});
  });
});
