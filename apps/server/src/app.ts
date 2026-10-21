import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import type { AppContext } from './context.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { catalogRoutes } from './routes/catalog.js';
import { partnerRoutes } from './routes/partners.js';
import { purchaseRoutes } from './routes/purchases.js';
import { inventoryRoutes } from './routes/inventory.js';
import { syncRoutes } from './routes/sync.js';
import { reportRoutes } from './routes/reports.js';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  const origins = ctx.config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins }));
  // Product images are embedded as data URLs, hence the larger limit.
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', async (_req, res) => {
    await ctx.db.query('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/sync', syncRoutes(ctx));
  app.use('/api/reports', reportRoutes(ctx));
  app.use('/api', adminRoutes(ctx));
  app.use('/api', catalogRoutes(ctx));
  app.use('/api', partnerRoutes(ctx));
  app.use('/api', purchaseRoutes(ctx));
  app.use('/api', inventoryRoutes(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler(ctx.log));
  return app;
}
