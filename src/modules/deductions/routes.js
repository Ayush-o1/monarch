import express from 'express';
import { z } from 'zod';
import { pool as defaultPool } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import { requireUser } from '../../middleware/requireUser.js';
import { validate } from '../../middleware/validate.js';
import { respondDeductionSchema } from './schemas.js';
import { respondDeduction } from './service.js';

const uuidParamSchema = z.string().uuid();

export function createDeductionsRouter({ pool = defaultPool } = {}) {
  const router = express.Router();
  router.use(requireUser);

  // PATCH /api/deductions/:id
  router.patch(
    '/:id',
    validate({ body: respondDeductionSchema }),
    async (req, res, next) => {
      const idParse = uuidParamSchema.safeParse(req.params.id);
      if (!idParse.success) {
        return next(new AppError(404, 'NOT_FOUND', 'Deduction line not found'));
      }

      try {
        const line = await respondDeduction(
          req.params.id,
          req.session.user.id,
          req.body,
          pool
        );
        res.status(200).json({ line });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
