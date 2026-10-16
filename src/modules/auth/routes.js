import express from 'express';
import { validate } from '../../middleware/validate.js';
import { registerSchema, loginSchema } from './schemas.js';
import { registerUser, loginUser } from './service.js';
import { authRateLimiter } from '../../middleware/rateLimits.js';
import { AppError } from '../../lib/errors.js';

export function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export function createAuthRouter({ rateLimiter = authRateLimiter } = {}) {
  const router = express.Router();

  router.post(
    '/api/auth/register',
    rateLimiter,
    validate({ body: registerSchema }),
    async (req, res, next) => {
      try {
        const user = await registerUser(req.body);
        await regenerateSession(req);
        req.session.user = user;
        res.status(201).json(user);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post(
    '/api/auth/login',
    rateLimiter,
    validate({ body: loginSchema }),
    async (req, res, next) => {
      try {
        const user = await loginUser(req.body);
        await regenerateSession(req);
        req.session.user = user;
        res.status(200).json(user);
      } catch (err) {
        next(err);
      }
    }
  );

  router.post('/api/auth/logout', async (req, res, next) => {
    try {
      if (req.session) {
        await destroySession(req);
      }
      res.clearCookie('monarch.sid');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get('/api/me', (req, res, next) => {
    if (!req.session || !req.session.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    res.status(200).json(req.session.user);
  });

  return router;
}

export const authRouter = createAuthRouter();
export default authRouter;
