import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateToken,
  hashToken,
  isValidTokenFormat,
} from '../../src/lib/tokens.js';

describe('Token Generation, Hashing, and Validation', () => {
  it('generates 43-character base64url tokens matching isValidTokenFormat', () => {
    const token = generateToken();
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 43);
    assert.equal(isValidTokenFormat(token), true);
  });

  it('rejects invalid token formats without querying database', () => {
    assert.equal(isValidTokenFormat(''), false);
    assert.equal(isValidTokenFormat('short'), false);
    assert.equal(isValidTokenFormat('a'.repeat(42)), false);
    assert.equal(isValidTokenFormat('a'.repeat(44)), false);
    assert.equal(isValidTokenFormat('a'.repeat(42) + '!'), false);
    assert.equal(isValidTokenFormat(null), false);
    assert.equal(isValidTokenFormat(undefined), false);
    assert.equal(isValidTokenFormat(12345), false);
  });

  it('hashToken is deterministic and produces 64 hex characters', () => {
    const token = generateToken();
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
    assert.match(hash1, /^[0-9a-f]{64}$/);
    assert.notEqual(hash1, token);
  });

  it('two generated tokens differ', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    assert.notEqual(t1, t2);
    assert.notEqual(hashToken(t1), hashToken(t2));
  });
});
