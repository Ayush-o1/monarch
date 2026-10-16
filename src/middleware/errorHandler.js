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

  // Postgres PL/pgSQL trigger lock exception
  if (
    err.message &&
    (err.message.startsWith('LOCKED:') || err.message.includes('LOCKED:'))
  ) {
    const cleanMsg = err.message.replace(/^.*LOCKED:\s*/, '');
    return res.status(409).json({
      error: {
        code: 'INSPECTION_LOCKED',
        message: cleanMsg,
        details: {},
      },
    });
  }

  // Postgres PL/pgSQL trigger parent item not found exception
  if (
    err.message &&
    (err.message.includes('Parent inspection item not found') ||
      err.message.includes('Parent inspection not found'))
  ) {
    return res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: err.message,
        details: {},
      },
    });
  }

  // Postgres unique violation on inspection items
  if (
    err.code === '23505' &&
    (err.constraint ===
      'inspection_items_inspection_id_lower_room_lower_name_idx' ||
      (err.message && err.message.includes('inspection_items')))
  ) {
    return res.status(409).json({
      error: {
        code: 'DUPLICATE_ITEM',
        message:
          'An item with this room and name already exists in this inspection',
        details: {},
      },
    });
  }

  // Postgres unique violation on media (item_id, sha256)
  if (
    err.code === '23505' &&
    (err.constraint === 'media_item_id_sha256_key' ||
      (err.message && err.message.includes('media')))
  ) {
    return res.status(409).json({
      error: {
        code: 'DUPLICATE_PHOTO',
        message: 'This photo has already been uploaded for this item',
        details: {},
      },
    });
  }

  // Multer file upload errors
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: {
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds maximum allowed upload size',
          details: {},
        },
      });
    }
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: err.message || 'File upload validation error',
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
