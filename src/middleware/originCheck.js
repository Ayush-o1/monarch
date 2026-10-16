import { AppError } from '../lib/errors.js';

export function originCheck(req, _res, next) {
  if (
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    req.method === 'OPTIONS'
  ) {
    return next();
  }

  const reqHost = req.get('host');
  const origin = req.get('origin');
  const referer = req.get('referer');

  let candidate = null;

  if (origin) {
    candidate = origin;
  } else if (referer) {
    candidate = referer;
  }

  // If neither Origin nor Referer is present, allow (for curl and automated tests)
  if (!candidate) {
    return next();
  }

  try {
    const candidateHost = new URL(candidate).host;
    if (candidateHost !== reqHost) {
      return next(
        new AppError(403, 'BAD_ORIGIN', 'Cross-origin request rejected')
      );
    }
  } catch {
    return next(
      new AppError(403, 'BAD_ORIGIN', 'Malformed origin or referer header')
    );
  }

  next();
}
