import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';

describe('Config validation', () => {
  const validBaseEnv = {
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: 'postgres://localhost:5432/monarch_dev',
    SESSION_SECRET: 'a-valid-session-secret-that-is-at-least-32-chars-long',
  };

  it('succeeds with valid environment variables', () => {
    const config = loadConfig(validBaseEnv);
    assert.equal(config.port, 3000);
    assert.equal(config.databaseUrl, 'postgres://localhost:5432/monarch_dev');
    assert.equal(config.cookieSecure, false);
    assert.equal(config.uploadDir, './uploads');
    assert.equal(config.maxUploadMb, 5);
    assert.equal(config.inviteTtlDays, 30);
  });

  it('uses TEST_DATABASE_URL when NODE_ENV=test', () => {
    const testEnv = {
      ...validBaseEnv,
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgres://localhost:5432/monarch_test',
    };
    const config = loadConfig(testEnv);
    assert.equal(config.databaseUrl, 'postgres://localhost:5432/monarch_test');
    assert.equal(config.isTest, true);
  });

  it('fails fast if SESSION_SECRET is missing', () => {
    const env = { ...validBaseEnv };
    delete env.SESSION_SECRET;

    assert.throws(() => loadConfig(env), /SESSION_SECRET is required/i);
  });

  it('fails fast if SESSION_SECRET is shorter than 32 characters', () => {
    const env = {
      ...validBaseEnv,
      SESSION_SECRET: 'short-secret-only-23-ch',
    };

    assert.throws(
      () => loadConfig(env),
      /SESSION_SECRET must be at least 32 characters/i
    );
  });

  it('fails fast if SESSION_SECRET is placeholder value in production', () => {
    const env = {
      ...validBaseEnv,
      NODE_ENV: 'production',
      SESSION_SECRET: 'replace-with-a-random-string-of-at-least-32-characters',
    };

    assert.throws(
      () => loadConfig(env),
      /SESSION_SECRET must not use the placeholder value in production/i
    );
  });

  it('does not leak SESSION_SECRET value in error message', () => {
    const badSecret = 'secret_12345';
    const env = {
      ...validBaseEnv,
      SESSION_SECRET: badSecret,
    };

    try {
      loadConfig(env);
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.message.includes(badSecret), false);
    }
  });

  it('fails fast if DATABASE_URL is missing in development', () => {
    const env = { ...validBaseEnv };
    delete env.DATABASE_URL;

    assert.throws(() => loadConfig(env), /DATABASE_URL is required/i);
  });

  it('fails fast if PORT is invalid', () => {
    const env = {
      ...validBaseEnv,
      PORT: 'not-a-number',
    };

    assert.throws(
      () => loadConfig(env),
      /PORT must be a valid positive integer/i
    );
  });
});
