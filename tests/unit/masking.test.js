import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitivePath } from '../../src/lib/masking.js';

describe('maskSensitivePath', () => {
  it('masks /l/<token> paths', () => {
    assert.equal(
      maskSensitivePath('/l/abc123def456789012345678901234567890123456789012345678901234'),
      '/l/:token'
    );
  });

  it('masks /l/<token>/compare paths', () => {
    assert.equal(
      maskSensitivePath('/l/abc123def456/compare'),
      '/l/:token/compare'
    );
  });

  it('masks /api/landlord/<token> paths and subroutes', () => {
    assert.equal(
      maskSensitivePath('/api/landlord/abc123def456/tenancy'),
      '/api/landlord/:token/tenancy'
    );
    assert.equal(
      maskSensitivePath('/api/landlord/abc123def456/media/123-456'),
      '/api/landlord/:token/media/123-456'
    );
    assert.equal(
      maskSensitivePath('/api/landlord/abc123def456/inspections/789/acknowledge'),
      '/api/landlord/:token/inspections/789/acknowledge'
    );
  });

  it('preserves query strings and hashes while masking the token segment', () => {
    assert.equal(
      maskSensitivePath('/l/secretToken123?ref=test#section'),
      '/l/:token?ref=test#section'
    );
    assert.equal(
      maskSensitivePath('/api/landlord/secretToken123/tenancy?foo=bar'),
      '/api/landlord/:token/tenancy?foo=bar'
    );
  });

  it('leaves non-sensitive paths unchanged', () => {
    assert.equal(maskSensitivePath('/api/tenancies/123-456'), '/api/tenancies/123-456');
    assert.equal(maskSensitivePath('/api/health'), '/api/health');
    assert.equal(maskSensitivePath('/login.html'), '/login.html');
    assert.equal(maskSensitivePath('/'), '/');
  });

  it('handles empty or non-string input safely', () => {
    assert.equal(maskSensitivePath(''), '');
    assert.equal(maskSensitivePath(null), '');
    assert.equal(maskSensitivePath(undefined), '');
    assert.equal(maskSensitivePath(123), '');
  });
});
