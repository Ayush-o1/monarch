import express from 'express';
import { z } from 'zod';
import { pool as defaultPool } from '../../db/pool.js';
import defaultStorage from '../../lib/storage/local.js';
import { AppError } from '../../lib/errors.js';
import { isValidTokenFormat } from '../../lib/tokens.js';
import { landlordRateLimiter as defaultLandlordLimiter } from '../../middleware/rateLimits.js';
import { validate } from '../../middleware/validate.js';
import { acknowledgeSchema, requestChangesSchema } from './schemas.js';
import {
  validateAndGetInvite,
  getLandlordTenancy,
  getLandlordMediaStream,
  acknowledgeInspection,
  requestChangesInspection,
} from './service.js';

const uuidParamSchema = z.string().uuid();

export function createLandlordRouter({
  pool = defaultPool,
  storage = defaultStorage,
  rateLimiter = defaultLandlordLimiter,
} = {}) {
  const router = express.Router();

  // Middleware: Landlord Token validation
  async function landlordTokenMiddleware(req, res, next) {
    const { token } = req.params;

    // Format validation without touching database
    if (!isValidTokenFormat(token)) {
      return next(new AppError(404, 'INVALID_LINK', 'This link is not valid'));
    }

    try {
      const invite = await validateAndGetInvite(token, pool);
      req.landlord = invite;
      next();
    } catch (err) {
      next(err);
    }
  }

  // All landlord routes get no-store Cache-Control and rate limiting
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use(rateLimiter);

  // GET /api/landlord/:token/tenancy
  router.get(
    '/api/landlord/:token/tenancy',
    landlordTokenMiddleware,
    async (req, res, next) => {
      try {
        const data = await getLandlordTenancy(req.landlord.tenancyId, pool);
        res.status(200).json(data);
      } catch (err) {
        next(err);
      }
    }
  );

  // GET /api/landlord/:token/media/:mediaId
  router.get(
    '/api/landlord/:token/media/:mediaId',
    landlordTokenMiddleware,
    async (req, res, next) => {
      const idParse = uuidParamSchema.safeParse(req.params.mediaId);
      if (!idParse.success) {
        return next(new AppError(404, 'NOT_FOUND', 'Media not found'));
      }

      try {
        const { stream, mime } = await getLandlordMediaStream(
          req.landlord.tenancyId,
          req.params.mediaId,
          { pool, storage }
        );
        res.setHeader('Content-Type', mime || 'image/jpeg');
        stream.pipe(res);
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/landlord/:token/inspections/:id/acknowledge
  router.post(
    '/api/landlord/:token/inspections/:id/acknowledge',
    landlordTokenMiddleware,
    validate({ body: acknowledgeSchema }),
    async (req, res, next) => {
      const idParse = uuidParamSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return next(new AppError(404, 'NOT_FOUND', 'Inspection not found'));
      }

      try {
        const inspection = await acknowledgeInspection(
          req.landlord.tenancyId,
          req.params.id,
          req.body.name,
          { pool }
        );
        res.status(200).json({ inspection });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/landlord/:token/inspections/:id/request-changes
  router.post(
    '/api/landlord/:token/inspections/:id/request-changes',
    landlordTokenMiddleware,
    validate({ body: requestChangesSchema }),
    async (req, res, next) => {
      const idParse = uuidParamSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return next(new AppError(404, 'NOT_FOUND', 'Inspection not found'));
      }

      try {
        const inspection = await requestChangesInspection(
          req.landlord.tenancyId,
          req.params.id,
          { name: req.body.name, note: req.body.note },
          { pool }
        );
        res.status(200).json({ inspection });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const landlordRouter = createLandlordRouter();
export default landlordRouter;
