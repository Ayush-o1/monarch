import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatPdfMoney,
  slugifyPropertyLabel,
  toPdfText,
} from '../../src/modules/report/formatters.js';

describe('Report formatters and text sanitisation (pure logic)', () => {
  describe('toPdfText', () => {
    it('handles null and undefined safely', () => {
      assert.equal(toPdfText(null), '');
      assert.equal(toPdfText(undefined), '');
      assert.equal(toPdfText(''), '');
    });

    it('replaces Indian Rupee symbol with ?', () => {
      assert.equal(toPdfText('₹ 500.00'), '? 500.00');
    });

    it('replaces non-Latin scripts (Kannada, Hindi, etc.) with ?', () => {
      assert.equal(toPdfText('ಬಾಡಿಗೆ ಮನೆ'), '?????? ???');
      assert.equal(toPdfText('किराया'), '??????');
    });

    it('replaces emojis with ?', () => {
      assert.equal(
        toPdfText('Keys handed over 🔑 😊'),
        'Keys handed over ?? ??'
      );
    });

    it('normalises tabs to spaces and preserves newlines', () => {
      assert.equal(toPdfText('Column1\tColumn2'), 'Column1 Column2');
      assert.equal(
        toPdfText('Line 1\r\nLine 2\rLine 3\n'),
        'Line 1\nLine 2\nLine 3\n'
      );
    });

    it('preserves standard printable ASCII and Latin-1 characters', () => {
      const latin1 = 'Café, façade, naïve, résumé & £100 © 2026';
      assert.equal(toPdfText(latin1), latin1);
    });

    it('handles very long strings without crashing or data loss of valid characters', () => {
      const longAscii = 'A'.repeat(5000);
      assert.equal(toPdfText(longAscii), longAscii);
      const longMixed = 'A'.repeat(2500) + '₹'.repeat(500) + 'B'.repeat(2000);
      const res = toPdfText(longMixed);
      assert.equal(res.length, 5000);
      assert.equal(res.slice(2500, 3000), '?'.repeat(500));
    });
  });

  describe('formatPdfMoney', () => {
    it('formats 0 paise', () => {
      assert.equal(formatPdfMoney(0), 'Rs 0.00');
    });

    it('formats 100 paise', () => {
      assert.equal(formatPdfMoney(100), 'Rs 1.00');
    });

    it('formats 1250050 paise', () => {
      assert.equal(formatPdfMoney(1250050), 'Rs 12,500.50');
    });

    it('formats 1000000000 paise (1 crore)', () => {
      assert.equal(formatPdfMoney(1000000000), 'Rs 1,00,00,000.00');
    });
  });

  describe('slugifyPropertyLabel', () => {
    it('handles spaces and mixed case', () => {
      assert.equal(
        slugifyPropertyLabel('Apartment 4B Green View'),
        'apartment-4b-green-view'
      );
    });

    it('handles non-ASCII and unicode by stripping or replacing with hyphens', () => {
      assert.equal(slugifyPropertyLabel('ಬೆಂಗಳೂರು ಫ್ಲಾಟ್'), 'report');
      assert.equal(slugifyPropertyLabel('Flat 101 - ಬೆಂಗಳೂರು'), 'flat-101');
    });

    it('handles empty or whitespace inputs by falling back to report', () => {
      assert.equal(slugifyPropertyLabel(''), 'report');
      assert.equal(slugifyPropertyLabel('   '), 'report');
      assert.equal(slugifyPropertyLabel(null), 'report');
      assert.equal(slugifyPropertyLabel(undefined), 'report');
      assert.equal(slugifyPropertyLabel('---'), 'report');
    });

    it('truncates very long labels to 40 characters without trailing hyphen', () => {
      const long =
        'very-long-property-label-that-exceeds-forty-characters-in-length';
      const slug = slugifyPropertyLabel(long);
      assert.ok(slug.length <= 40);
      assert.equal(slug, 'very-long-property-label-that-exceeds-fo');
      assert.doesNotMatch(slug, /-$/);
    });
  });
});
