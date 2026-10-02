import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { getInterpreterInfo } from './ai/index.js';
import { env } from './config/env.js';
import { checkDatabase } from './db/pool.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { appointmentsRouter } from './modules/appointments/appointments.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { chatRouter } from './modules/chat/chat.routes.js';
import { registerSubscribers } from './subscribers.js';

export function createApp() {
  registerSubscribers();

  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestLogger);
  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '32kb' }));

  // Liveness/readiness for the platform's health checks. Not rate limited.
  app.get('/health', async (_req, res) => {
    const dbUp = await checkDatabase();
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? 'ok' : 'degraded',
      database: dbUp ? 'up' : 'down',
      ai: getInterpreterInfo(),
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use(globalLimiter);

  const api = Router();
  api.use('/auth', authRouter);
  api.use('/', catalogRouter);
  api.use('/appointments', appointmentsRouter);
  api.use('/chat', chatRouter);
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
