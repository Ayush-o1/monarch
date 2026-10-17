/**
 * Masks sensitive tokens in URL paths (e.g. landlord invite tokens).
 * Replaces /l/<token> and /api/landlord/<token> segments with masked placeholders.
 *
 * @param {string} urlPath - The URL or path to mask
 * @returns {string} The masked path
 */
export function maskSensitivePath(urlPath) {
  if (typeof urlPath !== 'string') {
    return '';
  }
  return urlPath
    .replace(/\/api\/landlord\/[^/?#]+/g, '/api/landlord/:token')
    .replace(/\/l\/[^/?#]+/g, '/l/:token');
}
