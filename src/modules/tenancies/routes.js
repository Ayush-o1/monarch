import express from 'express';
import { requireUser } from '../../middleware/requireUser.js';
import { validate } from '../../middleware/validate.js';
import { createTenancySchema, tenancyIdParamSchema } from './schemas.js';
import {
  createTenancy,
  listTenancies,
  getTenancyById,
  getTenancyEvents,
  createInvite,
  revokeInvite,
} from './service.js';
import { AppError } from '../../lib/errors.js';

function validateTenancyId(req, _res, next) {
  const result = tenancyIdParamSchema.safeParse(req.params);
  if (!result.success) {
    return next(new AppError(404, 'NOT_FOUND', 'Tenancy not found'));
  }
  next();
}

export function createTenanciesRouter({ pool } = {}) {
  const router = express.Router();

  router.use(requireUser);

  router.post(
    '/',
    validate({ body: createTenancySchema }),
    async (req, res, next) => {
      try {
        const result = await createTenancy(
          {
            tenantId: req.session.user.id,
            actorName: req.session.user.name,
            ...req.body,
          },
          { pool }
        );
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  router.get('/', async (req, res, next) => {
    try {
      const list = await listTenancies(req.session.user.id, pool);
      res.status(200).json(list);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', validateTenancyId, async (req, res, next) => {
    try {
      const tenancy = await getTenancyById(
        req.params.id,
        req.session.user.id,
        pool
      );
      res.status(200).json(tenancy);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/events', validateTenancyId, async (req, res, next) => {
    try {
      const events = await getTenancyEvents(
        req.params.id,
        req.session.user.id,
        pool
      );
      res.status(200).json(events);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/invite', validateTenancyId, async (req, res, next) => {
    try {
      const result = await createInvite(req.params.id, req.session.user.id, {
        pool,
        actorName: req.session.user.name,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id/invite', validateTenancyId, async (req, res, next) => {
    try {
      await revokeInvite(req.params.id, req.session.user.id, {
        pool,
        actorName: req.session.user.name,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const tenanciesRouter = createTenanciesRouter();
export default tenanciesRouter;
