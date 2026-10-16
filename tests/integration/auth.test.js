import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { pool, ensureTestDb } from '../helpers/db.js';
import { createAuthRateLimiter } from '../../src/middleware/rateLimits.js';

describe('Authentication and Sessions', () => {
  let app;

  before(async () => {
    await ensureTestDb();
    // Allow general test suite to run unthrottled; isolated instance tests rate limits
    app = createApp({ pool, authLimiter: (_req, _res, next) => next() });
  });

  after(async () => {
    await pool.end();
  });

  function randomEmail() {
    return `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}@example.com`;
  }

  it('register returns 201 and logs in user; session persists across requests', async () => {
    const agent = request.agent(app);
    const email = randomEmail();
    const res = await agent
      .post('/api/auth/register')
      .send({ name: 'Alice Test', email, password: 'securepassword123' })
      .expect(201);

    assert.equal(res.body.name, 'Alice Test');
    assert.equal(res.body.email, email.toLowerCase());
    assert.equal(res.body.password_hash, undefined);
    assert.ok(res.body.id);

    // Verify session persistence
    const meRes = await agent.get('/api/me').expect(200);
    assert.equal(meRes.body.id, res.body.id);
    assert.equal(meRes.body.email, email.toLowerCase());
    assert.equal(meRes.body.password_hash, undefined);
  });

  it('short password returns 400 VALIDATION_ERROR with field details', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Bob Short', email: randomEmail(), password: 'short' })
      .expect(400);

    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(typeof res.body.error.details, 'object');
    assert.match(res.body.error.details.password, /at least 10/i);
  });

  it('duplicate email in different letter case returns 409 EMAIL_TAKEN', async () => {
    const base = `dup_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const emailUpper = `${base}@EXAMPLE.COM`;
    const emailLower = `${base}@example.com`;

    await request(app)
      .post('/api/auth/register')
      .send({ name: 'First User', email: emailUpper, password: 'password123' })
      .expect(201);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Second User', email: emailLower, password: 'password123' })
      .expect(409);

    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  it('wrong password and unknown email return identical 401 bodies', async () => {
    const email = randomEmail();
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Dave User', email, password: 'realpassword123' })
      .expect(201);

    const wrongPassRes = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrongpassword123' })
      .expect(401);

    const unknownEmailRes = await request(app)
      .post('/api/auth/login')
      .send({ email: `unknown_${randomEmail()}`, password: 'wrongpassword123' })
      .expect(401);

    assert.deepEqual(wrongPassRes.body, unknownEmailRes.body);
    assert.equal(wrongPassRes.body.error.code, 'INVALID_CREDENTIALS');
  });

  it('/api/me returns 401 UNAUTHORIZED without a session', async () => {
    const res = await request(app).get('/api/me').expect(401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  it('logout destroys session and subsequent /api/me returns 401', async () => {
    const agent = request.agent(app);
    const email = randomEmail();

    await agent
      .post('/api/auth/register')
      .send({ name: 'Eve Logout', email, password: 'password123' })
      .expect(201);

    await agent.get('/api/me').expect(200);

    const logoutRes = await agent.post('/api/auth/logout').expect(204);
    assert.equal(logoutRes.text, '');

    const meRes = await agent.get('/api/me').expect(401);
    assert.equal(meRes.body.error.code, 'UNAUTHORIZED');
  });

  it('cross-origin non-GET request returns 403 BAD_ORIGIN', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Origin', 'https://malicious-site.example')
      .send({
        name: 'Frank Attacker',
        email: randomEmail(),
        password: 'password123',
      })
      .expect(403);

    assert.equal(res.body.error.code, 'BAD_ORIGIN');
  });

  it('11th login attempt within window receives 429 RATE_LIMIT_EXCEEDED', async () => {
    // Isolated app instance with rate limiter allowing 10 requests
    const isolatedLimiter = createAuthRateLimiter({
      max: 10,
      windowMs: 15 * 60 * 1000,
    });
    const limitedApp = createApp({ pool, authLimiter: isolatedLimiter });

    const email = randomEmail();
    for (let i = 0; i < 10; i++) {
      await request(limitedApp)
        .post('/api/auth/login')
        .send({ email, password: 'badpassword' })
        .expect(401);
    }

    const res = await request(limitedApp)
      .post('/api/auth/login')
      .send({ email, password: 'badpassword' })
      .expect(429);

    assert.equal(res.body.error.code, 'RATE_LIMIT_EXCEEDED');
  });

  it('no response body ever contains password_hash', async () => {
    const email = randomEmail();
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ name: 'No Hash', email, password: 'password123' })
      .expect(201);

    assert.equal(JSON.stringify(regRes.body).includes('password_hash'), false);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'password123' })
      .expect(200);

    assert.equal(
      JSON.stringify(loginRes.body).includes('password_hash'),
      false
    );
  });

  it('session id cookie value differs before and after login', async () => {
    const email1 = randomEmail();
    const email2 = randomEmail();

    // Register user2 first
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'User Two', email: email2, password: 'password123' })
      .expect(201);

    const agent = request.agent(app);

    // Initial registration under agent yields session cookie 1
    const regRes = await agent
      .post('/api/auth/register')
      .send({ name: 'User One', email: email1, password: 'password123' })
      .expect(201);
    const initialCookie = regRes.headers['set-cookie']?.[0] || '';

    // Subsequent login regenerates session ID, yielding a new cookie value
    const loginRes = await agent
      .post('/api/auth/login')
      .send({ email: email2, password: 'password123' })
      .expect(200);
    const postLoginCookie = loginRes.headers['set-cookie']?.[0] || '';

    assert.ok(initialCookie);
    assert.ok(postLoginCookie);
    assert.notEqual(initialCookie, postLoginCookie);
  });

  it('Set-Cookie carries HttpOnly and SameSite=Lax flags', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Cookie Test',
        email: randomEmail(),
        password: 'password123',
      })
      .expect(201);

    const cookies = res.headers['set-cookie'];
    assert.ok(Array.isArray(cookies) && cookies.length > 0);
    const sessionCookie = cookies.find((c) => c.startsWith('monarch.sid='));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
  });

  it('two simultaneous registrations with the same email result in one 201 and one 409', async () => {
    const email = randomEmail();

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/auth/register')
        .send({ name: 'Race One', email, password: 'password123' }),
      request(app)
        .post('/api/auth/register')
        .send({ name: 'Race Two', email, password: 'password123' }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [201, 409]);
  });
});
