import { Router, type RequestHandler } from 'express';
import { config } from './config';

export interface ShortLink {
  id: number;
  originalUrl: string;
  code: string;
  createdAt: Date;
  hitCount: number;
}

export interface ShortenerStoreLike {
  create(originalUrl: string): Promise<ShortLink>;
  findByCode(code: string): Promise<ShortLink | null>;
  incrementHit(code: string): Promise<void>;
  getAll(): Promise<ShortLink[]>;
}

export interface RouterDeps {
  store: ShortenerStoreLike;
  shortenRateLimiter: RequestHandler;
}

const MAX_ORIGINAL_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const isValidUrl = (value: string): boolean => {
  if (value.length > MAX_ORIGINAL_URL_LENGTH) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
};

export const createRouter = ({ store, shortenRateLimiter }: RouterDeps): Router => {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ message: 'URL Shortener API ready' });
  });

  router.post('/shorten', shortenRateLimiter, async (req, res) => {
    const { url } = req.body as { url?: string };

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'The url field must be a string.' });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({ error: 'The provided value is not a valid URL.' });
    }

    try {
      const link = await store.create(url);

      const baseUrl = config.BASE_URL || `http://localhost:${config.PORT}`;
      const shortUrl = `${baseUrl}/r/${link.code}`;

      return res.status(201).json({
        id: link.id,
        originalUrl: link.originalUrl,
        code: link.code,
        shortUrl,
        createdAt: link.createdAt,
      });
    } catch (err) {
      console.error('[POST /shorten] error:', err);
      return res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });

  router.get('/r/:code', async (req, res) => {
    const { code } = req.params;

    try {
      const link = await store.findByCode(code);
      if (!link) {
        return res.status(404).json({ error: 'No URL was found for the provided code.' });
      }

      await store.incrementHit(code);

      return res.redirect(302, link.originalUrl);
    } catch (err) {
      console.error('[GET /r/:code] error:', err);
      return res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });

  router.get('/links', async (_req, res) => {
    try {
      const links = await store.getAll();
      const baseUrl = config.BASE_URL || `http://localhost:${config.PORT}`;

      const result = links.map((link) => ({
        id: link.id,
        originalUrl: link.originalUrl,
        code: link.code,
        shortUrl: `${baseUrl}/r/${link.code}`,
        createdAt: link.createdAt,
        hitCount: link.hitCount,
      }));

      return res.json(result);
    } catch (err) {
      console.error('[GET /links] error:', err);
      return res.status(500).json({ error: 'An internal server error occurred.' });
    }
  });

  return router;
};
