import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import config from './config.js';
import { AppError } from './lib/errors.js';
import { maskSensitivePath } from './lib/masking.js';
import { errorHandler } from './middleware/errorHandler.js';
import { originCheck } from './middleware/originCheck.js';
import { pool as defaultPool } from './db/pool.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createTenanciesRouter } from './modules/tenancies/routes.js';
import { createItemsRouter } from './modules/items/routes.js';
import { createMediaRouter } from './modules/media/routes.js';
import { createLandlordRouter } from './modules/landlord/routes.js';
import { createDeductionsRouter } from './modules/deductions/routes.js';
import { createReportRouter } from './modules/report/routes.js';

const PgSession = connectPgSimple(session);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({
  pool = defaultPool,
  authLimiter,
  mediaLimiter,
  landlordLimiter,
  storage,
  maxUploadMb,
  sessionStore,
  sessionSecret = config.sessionSecret,
  cookieSecure = config.cookieSecure,
  reportCompress = true,
} = {}) {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  if (cookieSecure) {
    app.set('trust proxy', 1);
  }

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

  // Sessions with Postgres store
  const store =
    sessionStore ||
    new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: false,
    });

  app.use(
    session({
      store,
      name: 'monarch.sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // CSRF defence for non-GET /api requests
  app.use('/api', originCheck);

  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/api/health', async (_req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      next(
        new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is unreachable')
      );
    }
  });

  // Auth routes
  app.use(createAuthRouter({ rateLimiter: authLimiter }));

  // Tenancies routes
  app.use('/api/tenancies', createTenanciesRouter({ pool }));

  // Report routes
  app.use(
    '/api/tenancies',
    createReportRouter({ pool, storage, reportCompress })
  );

  // Inspections and items routes
  app.use(createItemsRouter({ pool, storage }));

  // Media routes
  app.use(
    createMediaRouter({
      pool,
      storage,
      uploadLimiter: mediaLimiter,
      maxUploadMb,
    })
  );

  // Deductions routes
  app.use('/api/deductions', createDeductionsRouter({ pool }));

  // Landlord token API routes
  app.use(
    createLandlordRouter({
      pool,
      storage,
      rateLimiter: landlordLimiter,
    })
  );

  // Landlord comparison page route
  app.get('/l/:token/compare', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.sendFile(path.join(__dirname, '../public/compare.html'));
  });

  // Landlord review page route
  app.get('/l/:token', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.sendFile(path.join(__dirname, '../public/landlord.html'));
  });

  app.all('/api/*', (req, _res, next) => {
    const safePath = maskSensitivePath(req.path);
    next(
      new AppError(
        404,
        'NOT_FOUND',
        `Route ${req.method} ${safePath} not found`
      )
    );
  });

  // 404 handler for non-API routes
  app.use((req, res, next) => {
    const safePath = maskSensitivePath(req.path);
    next(
      new AppError(
        404,
        'NOT_FOUND',
        `Route ${req.method} ${safePath} not found`
      )
    );
  });

  app.use(errorHandler);

  return app;
}

const app = createApp();
export default app;
