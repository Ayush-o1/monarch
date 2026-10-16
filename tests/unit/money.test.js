import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRupeesToPaise, formatPaise } from '../../public/js/money.js';

describe('Money parsing and formatting (pure logic)', () => {
  it('parses valid integer and decimal rupee strings to paise', () => {
    assert.equal(parseRupeesToPaise('12500.5'), 1250050);
    assert.equal(parseRupeesToPaise('12,500'), 1250000);
    assert.equal(parseRupeesToPaise('12500'), 1250000);
    assert.equal(parseRupeesToPaise('0.50'), 50);
    assert.equal(parseRupeesToPaise('0.05'), 5);
    assert.equal(parseRupeesToPaise(100), 10000);
  });

  it('rejects more than 2 decimal places, non-numeric strings, empty inputs, and negatives', () => {
    assert.throws(() => parseRupeesToPaise('0.001'), /Invalid rupee amount/i);
    assert.throws(() => parseRupeesToPaise('abc'), /Invalid rupee amount/i);
    assert.throws(() => parseRupeesToPaise(''), /Invalid rupee amount/i);
    assert.throws(() => parseRupeesToPaise('   '), /Invalid rupee amount/i);
    assert.throws(() => parseRupeesToPaise('-500'), /Invalid rupee amount/i);
    assert.throws(() => parseRupeesToPaise('0'), /must be greater than zero/i);
    assert.throws(() => parseRupeesToPaise(null), /empty/i);
    assert.throws(() => parseRupeesToPaise(undefined), /empty/i);
  });

  it('formats paise into Indian Rupee style correctly', () => {
    const formatted = formatPaise(1250050);
    // Should contain 12,500.50 and currency symbol
    assert.match(formatted, /12,500\.50/);
    assert.equal(formatPaise(0), '₹0.00');
  });
});
