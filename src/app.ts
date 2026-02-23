import path from 'path';
import express from 'express';
import helmet from 'helmet';
import { config } from './config';
import { createRouter, type ShortenerStoreLike } from './routes';
import { shortenRateLimiter } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';

export interface AppDeps {
  store: ShortenerStoreLike;
}

export const createApp = ({ store }: AppDeps) => {
  const app = express();

  if (config.TRUST_PROXY !== undefined) {
    app.set('trust proxy', config.TRUST_PROXY);
  }

  app.use(helmet());
  app.use(express.static(path.join(__dirname, '../public')));
  app.use(express.json());

  app.use('/', createRouter({ store, shortenRateLimiter }));
  app.use(errorHandler);

  return app;
};
