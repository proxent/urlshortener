import { Router } from 'express';
import { shortenerStore } from './shortenerStore';
import { config } from './config';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ message: 'URL Shortener API ready' });
});

const isValidUrl = (value: string): boolean => {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

router.post('/shorten', async (req, res) => {
  const { url } = req.body as { url?: string };

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'The url field must be a string.' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'The URL is not valid.' });
  }

  try {
    const link = await shortenerStore.create(url);

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
    const link = await shortenerStore.findByCode(code);
    if (!link) {
      return res.status(404).json({ error: 'Could not find a URL for the provided code.' });
    }

    await shortenerStore.incrementHit(code);

    return res.redirect(302, link.originalUrl);
  } catch (err) {
    console.error('[GET /r/:code] error:', err);
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

router.get('/links', async (_req, res) => {
  try {
    const links = await shortenerStore.getAll();
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

export default router;
