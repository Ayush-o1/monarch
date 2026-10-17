import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSettlement } from '../../src/lib/settlement.js';

describe('Settlement Mathematics (pure logic)', () => {
  it('handles empty lines array and default parameters', () => {
    const res = computeSettlement();
    assert.equal(res.depositPaise, 0);
    assert.equal(res.acceptedPaise, 0);
    assert.equal(res.proposedPaise, 0);
    assert.equal(res.disputedPaise, 0);
    assert.equal(res.unclaimedPaise, 0);
    assert.deepEqual(res.counts, {
      proposed: 0,
      accepted: 0,
      disputed: 0,
      withdrawn: 0,
      total: 0,
    });
    assert.equal(res.daysSinceMoveOut, null);
    assert.equal(res.refundWindowDays, null);
    assert.equal(res.windowRemainingDays, null);
  });

  it('excludes withdrawn lines from all sums but includes them in counts', () => {
    const lines = [
      { id: '1', amountPaise: 5000, status: 'proposed' },
      { id: '2', amountPaise: 10000, status: 'withdrawn' },
      { id: '3', amountPaise: 15000, status: 'accepted' },
      { id: '4', amountPaise: 20000, status: 'withdrawn' },
      { id: '5', amountPaise: 7000, status: 'disputed' },
    ];

    const res = computeSettlement({
      depositPaise: 50000,
      lines,
    });

    assert.equal(res.depositPaise, 50000);
    assert.equal(res.proposedPaise, 5000);
    assert.equal(res.acceptedPaise, 15000);
    assert.equal(res.disputedPaise, 7000);
    assert.equal(res.unclaimedPaise, 50000 - 5000 - 15000 - 7000); // 23000
    assert.deepEqual(res.counts, {
      proposed: 1,
      accepted: 1,
      disputed: 1,
      withdrawn: 2,
      total: 5,
    });
  });

  it('handles all-accepted scenario correctly', () => {
    const lines = [
      { id: '1', amountPaise: 20000, status: 'accepted' },
      { id: '2', amountPaise: 30000, status: 'accepted' },
    ];

    const res = computeSettlement({
      depositPaise: 50000,
      lines,
    });

    assert.equal(res.depositPaise, 50000);
    assert.equal(res.acceptedPaise, 50000);
    assert.equal(res.proposedPaise, 0);
    assert.equal(res.disputedPaise, 0);
    assert.equal(res.unclaimedPaise, 0);
    assert.equal(res.counts.accepted, 2);
    assert.equal(res.counts.total, 2);
  });

  it('handles boundaries: zero deposit, exact deposit claim, and snake_case properties', () => {
    const lines = [
      { id: '1', amount_paise: 25000, status: 'proposed' },
      { id: '2', amount_paise: 25000, status: 'disputed' },
    ];

    const res = computeSettlement({
      depositPaise: 50000,
      lines,
    });

    assert.equal(res.unclaimedPaise, 0);
    assert.equal(res.proposedPaise, 25000);
    assert.equal(res.disputedPaise, 25000);
  });

  it('calculates days elapsed and negative remaining days when window is exceeded', () => {
    const submittedAt = new Date('2026-10-01T10:00:00Z');
    const nowPast = new Date('2026-10-21T10:00:00Z'); // 20 days later

    const res = computeSettlement({
      depositPaise: 40000,
      lines: [],
      moveOutSubmittedAt: submittedAt,
      refundWindowDays: 14,
      now: nowPast,
    });

    assert.equal(res.daysSinceMoveOut, 20);
    assert.equal(res.refundWindowDays, 14);
    assert.equal(res.windowRemainingDays, -6); // 14 - 20 = -6
  });

  it('calculates positive remaining days when within refund window', () => {
    const submittedAt = new Date('2026-10-10T10:00:00Z');
    const now = new Date('2026-10-14T10:00:00Z'); // 4 days later

    const res = computeSettlement({
      depositPaise: 40000,
      lines: [],
      moveOutSubmittedAt: submittedAt,
      refundWindowDays: 14,
      now,
    });

    assert.equal(res.daysSinceMoveOut, 4);
    assert.equal(res.refundWindowDays, 14);
    assert.equal(res.windowRemainingDays, 10); // 14 - 4 = 10
  });

  it('returns null for windowRemainingDays if refundWindowDays is null', () => {
    const submittedAt = new Date('2026-10-10T10:00:00Z');
    const now = new Date('2026-10-14T10:00:00Z');

    const res = computeSettlement({
      depositPaise: 40000,
      lines: [],
      moveOutSubmittedAt: submittedAt,
      refundWindowDays: null,
      now,
    });

    assert.equal(res.daysSinceMoveOut, 4);
    assert.equal(res.refundWindowDays, null);
    assert.equal(res.windowRemainingDays, null);
  });
});
