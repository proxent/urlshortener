import path from 'path';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { createRouter, type ShortenerStoreLike } from './routes';
import { shortenRateLimiter } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';

export interface AppStoreLike extends ShortenerStoreLike {
  checkReadiness(): Promise<void>;
}

export interface AppDeps {
  store: AppStoreLike;
}

export const createApp = ({ store }: AppDeps) => {
  const app = express();

  if (config.TRUST_PROXY !== undefined) {
    app.set('trust proxy', config.TRUST_PROXY);
  }

  app.use(helmet());

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

  app.use(express.static(path.join(__dirname, '../public')));
  app.use(express.json());

  app.use('/', createRouter({ store, shortenRateLimiter }));
  app.use(errorHandler);

  return app;
};
