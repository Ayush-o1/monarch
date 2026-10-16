import { AppError } from '../lib/errors.js';

export function validate({ body, query, params } = {}) {
  return (req, _res, next) => {
    const details = {};

    if (body) {
      const result = body.safeParse(req.body);
      if (!result.success) {
        for (const issue of result.error.issues) {
          const field = issue.path.join('.') || 'body';
          details[field] = issue.message;
        }
      } else {
        req.body = result.data;
      }
    }

    if (query) {
      const result = query.safeParse(req.query);
      if (!result.success) {
        for (const issue of result.error.issues) {
          const field = issue.path.join('.') || 'query';
          details[field] = issue.message;
        }
      } else {
        req.query = result.data;
      }
    }

    if (params) {
      const result = params.safeParse(req.params);
      if (!result.success) {
        for (const issue of result.error.issues) {
          const field = issue.path.join('.') || 'params';
          details[field] = issue.message;
        }
      } else {
        req.params = result.data;
      }
    }

    if (Object.keys(details).length > 0) {
      return next(
        new AppError(400, 'VALIDATION_ERROR', 'Validation failed', details)
      );
    }

    next();
  };
}
