import rateLimit from 'express-rate-limit';
import { AppError } from '../lib/errors.js';

export function createAuthRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const max = options.max !== undefined ? options.max : 10;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMIT_EXCEEDED',
          'Too many requests, please try again later'
        )
      );
    },
    ...options,
  });
}

export const authRateLimiter = createAuthRateLimiter();

export function createMediaUploadRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max !== undefined ? options.max : 30;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMIT_EXCEEDED',
          'Too many uploads, please try again later'
        )
      );
    },
    ...options,
  });
}

export const mediaUploadRateLimiter = createMediaUploadRateLimiter();

export function createLandlordRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000;
  const max = options.max !== undefined ? options.max : 60;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMIT_EXCEEDED',
          'Too many requests, please try again later'
        )
      );
    },
    ...options,
  });
}

export const landlordRateLimiter = createLandlordRateLimiter();
