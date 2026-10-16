import express from 'express';
import multer from 'multer';
import config from '../../config.js';
import { requireUser } from '../../middleware/requireUser.js';
import { mediaUploadRateLimiter } from '../../middleware/rateLimits.js';
import { mediaIdParamSchema } from './schemas.js';
import { uploadMedia, getMediaStream, deleteMedia } from './service.js';
import { AppError } from '../../lib/errors.js';

function validateIdParam(req, _res, next) {
  const result = mediaIdParamSchema.safeParse(req.params);
  if (!result.success) {
    return next(new AppError(404, 'NOT_FOUND', 'Resource not found'));
  }
  next();
}

export function createMediaRouter({
  pool,
  storage,
  uploadLimiter = mediaUploadRateLimiter,
  maxUploadMb = config.maxUploadMb,
} = {}) {
  const router = express.Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.floor(maxUploadMb * 1024 * 1024),
      files: 1,
      fields: 0,
    },
  }).single('photo');

  function handleUpload(req, res, next) {
    upload(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new AppError(
              413,
              'FILE_TOO_LARGE',
              `File size exceeds ${maxUploadMb}MB limit`
            )
          );
        }
        return next(
          new AppError(
            400,
            'VALIDATION_ERROR',
            err.message || 'File upload error'
          )
        );
      }
      if (!req.file) {
        return next(
          new AppError(400, 'VALIDATION_ERROR', 'photo field is required')
        );
      }
      next();
    });
  }

  // POST /api/items/:id/media
  router.post(
    '/api/items/:id/media',
    requireUser,
    uploadLimiter,
    validateIdParam,
    handleUpload,
    async (req, res, next) => {
      try {
        const result = await uploadMedia({
          itemId: req.params.id,
          tenantId: req.session.user.id,
          fileBuffer: req.file.buffer,
          pool,
          storage,
        });
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /api/media/:id
  router.get(
    '/api/media/:id',
    requireUser,
    validateIdParam,
    async (req, res, next) => {
      try {
        const { stream } = await getMediaStream({
          mediaId: req.params.id,
          tenantId: req.session.user.id,
          pool,
          storage,
        });

        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Content-Disposition', 'inline');

        stream.pipe(res);
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /api/media/:id
  router.delete(
    '/api/media/:id',
    requireUser,
    validateIdParam,
    async (req, res, next) => {
      try {
        const result = await deleteMedia({
          mediaId: req.params.id,
          tenantId: req.session.user.id,
          pool,
          storage,
        });
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const mediaRouter = createMediaRouter();
export default mediaRouter;
