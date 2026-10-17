import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';

describe('Error Pages and 404 Fallback Handling', () => {
  let app;

  before(async () => {
    await ensureTestDb();
    app = createApp({ pool });
  });

  after(async () => {
    await pool.end();
  });

  it('unknown GET request accepting text/html returns 404.html with status 404', async () => {
    const res = await request(app)
      .get('/nonexistent-page-url')
      .set('Accept', 'text/html,application/xhtml+xml')
      .expect(404);

    assert.ok(res.headers['content-type']?.includes('text/html'));
    assert.match(res.text, /Page Not Found/i);
    assert.match(res.text, /Return to Dashboard/i);
  });

  it('unknown /api/* routes return JSON 404 error regardless of Accept header', async () => {
    const res = await request(app)
      .get('/api/unknown-endpoint')
      .set('Accept', 'text/html')
      .expect(404);

    assert.ok(res.headers['content-type']?.includes('application/json'));
    assert.equal(res.body.error?.code, 'NOT_FOUND');
    assert.match(res.body.error?.message, /Route GET \/api\/unknown-endpoint not found/);
  });

  it('unknown non-GET requests return JSON 404', async () => {
    const resPost = await request(app)
      .post('/some-unknown-post-path')
      .set('Accept', 'text/html')
      .send({ test: true })
      .expect(404);

    assert.ok(resPost.headers['content-type']?.includes('application/json'));
    assert.equal(resPost.body.error?.code, 'NOT_FOUND');

    const resDelete = await request(app)
      .delete('/some-unknown-delete-path')
      .expect(404);

    assert.ok(resDelete.headers['content-type']?.includes('application/json'));
    assert.equal(resDelete.body.error?.code, 'NOT_FOUND');
  });

  it('unknown GET request expecting JSON returns JSON 404', async () => {
    const res = await request(app)
      .get('/some-nonexistent-path')
      .set('Accept', 'application/json')
      .expect(404);

    assert.ok(res.headers['content-type']?.includes('application/json'));
    assert.equal(res.body.error?.code, 'NOT_FOUND');
  });
});
