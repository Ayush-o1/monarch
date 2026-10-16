import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './lib/errors.js';
import { errorHandler } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: isProduction ? [] : null,
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    })
  );

  app.use(express.json({ limit: '100kb' }));

  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.all('/api/*', (req, _res, next) => {
    next(
      new AppError(
        404,
        'NOT_FOUND',
        `Route ${req.method} ${req.path} not found`
      )
    );
  });

  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
