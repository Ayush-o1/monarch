import { AppError } from '../lib/errors.js';

export function requireUser(req, _res, next) {
  if (!req.session || !req.session.user) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }
  next();
}
