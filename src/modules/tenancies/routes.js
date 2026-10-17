import express from 'express';
import { requireUser } from '../../middleware/requireUser.js';
import { validate } from '../../middleware/validate.js';
import { createTenancySchema, tenancyIdParamSchema } from './schemas.js';
import { closeTenancySchema } from '../deductions/schemas.js';
import {
  createTenancy,
  listTenancies,
  getTenancyById,
  getTenancyEvents,
  createInvite,
  revokeInvite,
  startMoveOut,
  getTenancyComparison,
} from './service.js';
import { getSettlementData, closeTenancy } from '../deductions/service.js';
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

  router.post('/:id/move-out', validateTenancyId, async (req, res, next) => {
    try {
      const result = await startMoveOut(req.params.id, req.session.user.id, {
        pool,
        actorName: req.session.user.name,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id/comparison', validateTenancyId, async (req, res, next) => {
    try {
      const result = await getTenancyComparison(
        req.params.id,
        req.session.user.id,
        pool
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tenancies/:id/settlement
  router.get('/:id/settlement', validateTenancyId, async (req, res, next) => {
    try {
      const tCheck = await pool.query(
        'SELECT id FROM tenancies WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.session.user.id]
      );
      if (tCheck.rowCount === 0) {
        return next(new AppError(404, 'NOT_FOUND', 'Tenancy not found'));
      }

      const data = await getSettlementData(req.params.id, pool);
      res.status(200).json(data);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/tenancies/:id/close
  router.post(
    '/:id/close',
    validateTenancyId,
    validate({ body: closeTenancySchema }),
    async (req, res, next) => {
      try {
        const result = await closeTenancy(
          req.params.id,
          req.session.user.id,
          req.body,
          pool
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

export const tenanciesRouter = createTenanciesRouter();
export default tenanciesRouter;
