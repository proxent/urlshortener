import path from 'path';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { createRouter, type ShortenerStoreLike } from './routes';
import { shortenRateLimiter } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';
import { metricsHandler, prometheusMiddleware } from './metrics';

export interface AppStoreLike extends ShortenerStoreLike {
  checkReadiness(): Promise<void>;
}

export interface AppDeps {
  store: AppStoreLike;
}

export const createApp = ({ store }: AppDeps) => {
  const app = express();
  const publicDir = path.join(__dirname, '../public');

  if (config.TRUST_PROXY !== undefined) {
    app.set('trust proxy', config.TRUST_PROXY);
  }

  app.use(helmet());
  app.get('/metrics', metricsHandler);

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/readyz', async (_req, res) => {
    try {
      await store.checkReadiness();
      return res.status(200).json({ status: 'ready' });
    } catch (err) {
      console.error('[GET /readyz] error:', err);
      return res.status(503).json({ status: 'not ready' });
    }
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.get('/app.js', (_req, res) => {
    res.sendFile(path.join(publicDir, 'app.js'));
  });

  app.use('/shorten', express.json());
  app.use(prometheusMiddleware);

  app.use('/', createRouter({ store, shortenRateLimiter }));
  app.use(errorHandler);

  return app;
};
