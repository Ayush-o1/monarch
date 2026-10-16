import { AppError } from '../lib/errors.js';

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details || {},
      },
    });
  }

  if (err.message && err.message.startsWith('LOCKED:')) {
    return res.status(409).json({
      error: {
        code: 'INSPECTION_LOCKED',
        message: err.message.replace(/^LOCKED:\s*/, ''),
        details: {},
      },
    });
  }

  const status = typeof err.status === 'number' ? err.status : 500;
  const isProduction = process.env.NODE_ENV === 'production';
  const code =
    err.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
  const message =
    status === 500 && isProduction
      ? 'Internal server error'
      : err.message || 'Internal server error';

  return res.status(status).json({
    error: {
      code,
      message,
      details: err.details || {},
    },
  });
}
