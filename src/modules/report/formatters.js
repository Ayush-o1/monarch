/**
 * Formats user-provided text for PDFKit built-in Helvetica font.
 * Replaces any character outside printable Latin-1 with '?' and normalizes whitespace/newlines.
 *
 * @param {string|null|undefined} s
 * @returns {string}
 */
export function toPdfText(s) {
  if (s === null || s === undefined) return '';
  const str = String(s)
    .replace(/\r\n|\r/g, '\n')
    .replace(/\t/g, ' ');
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    // Allow newline (\n = 10)
    // Printable ASCII (32-126)
    // Printable Latin-1 Supplement (160-255)
    if (
      code === 10 ||
      (code >= 32 && code <= 126) ||
      (code >= 160 && code <= 255)
    ) {
      out += str[i];
    } else {
      out += '?';
    }
  }
  return out;
}

/**
 * Formats money in paise into Indian Rupee style with "Rs " prefix.
 * Built-in Helvetica does not support the rupee symbol (U+20B9), so "Rs " is used.
 *
 * @param {number|bigint} paise
 * @returns {string} e.g. "Rs 12,500.50"
 */
export function formatPdfMoney(paise) {
  const num = Number(paise || 0);
  const rupees = num / 100;
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees);
  return `Rs ${formatted}`;
}

/**
 * Creates a pure ASCII URL- and filename-safe slug from a property label.
 * Lowercase, replaces non-alphanumeric with hyphens, collapses consecutive hyphens,
 * trims hyphens, limits to 40 characters, and falls back to "report".
 *
 * @param {string|null|undefined} label
 * @returns {string}
 */
export function slugifyPropertyLabel(label) {
  if (!label) return 'report';
  const slug = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'report';
}
