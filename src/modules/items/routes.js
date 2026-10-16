import express from 'express';
import { requireUser } from '../../middleware/requireUser.js';
import { validate } from '../../middleware/validate.js';
import { createItemSchema, patchItemSchema, idParamSchema } from './schemas.js';
import {
  createInspectionItem,
  patchInspectionItem,
  deleteInspectionItem,
  getInspectionWithItems,
  submitInspection,
} from './service.js';
import { AppError } from '../../lib/errors.js';

function validateIdParam(req, _res, next) {
  const result = idParamSchema.safeParse(req.params);
  if (!result.success) {
    return next(new AppError(404, 'NOT_FOUND', 'Resource not found'));
  }
  next();
}

export function createItemsRouter({ pool, storage } = {}) {
  const router = express.Router();

  // GET /api/inspections/:id
  router.get(
    '/api/inspections/:id',
    requireUser,
    validateIdParam,
    async (req, res, next) => {
      try {
        const inspection = await getInspectionWithItems(
          req.params.id,
          req.session.user.id,
          pool
        );
        res.status(200).json(inspection);
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/inspections/:id/submit
  router.post(
    '/api/inspections/:id/submit',
    requireUser,
    validateIdParam,
    async (req, res, next) => {
      try {
        const result = await submitInspection(
          req.params.id,
          req.session.user.id,
          {
            pool,
            actorName: req.session.user.name,
          }
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/inspections/:id/items
  router.post(
    '/api/inspections/:id/items',
    requireUser,
    validateIdParam,
    validate({ body: createItemSchema }),
    async (req, res, next) => {
      try {
        const item = await createInspectionItem(
          req.params.id,
          req.session.user.id,
          req.body,
          pool
        );
        res.status(201).json(item);
      } catch (err) {
        next(err);
      }
    }
  );

  // PATCH /api/items/:id
  router.patch(
    '/api/items/:id',
    requireUser,
    validateIdParam,
    validate({ body: patchItemSchema }),
    async (req, res, next) => {
      try {
        const updated = await patchInspectionItem(
          req.params.id,
          req.session.user.id,
          req.body,
          pool
        );
        res.status(200).json(updated);
      } catch (err) {
        next(err);
      }
    }
  );

  // DELETE /api/items/:id
  router.delete(
    '/api/items/:id',
    requireUser,
    validateIdParam,
    async (req, res, next) => {
      try {
        await deleteInspectionItem(
          req.params.id,
          req.session.user.id,
          pool,
          storage
        );
        res.status(200).json({ success: true });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const itemsRouter = createItemsRouter();
export default itemsRouter;
