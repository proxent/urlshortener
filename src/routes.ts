// src/routes.ts
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

// 1) URL 단축 생성: POST /shorten
router.post('/shorten', async (req, res) => {
  const { url } = req.body as { url?: string };

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url 필드는 반드시 string이어야 합니다.' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: '유효한 URL이 아닙니다.' });
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
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 2) 리다이렉트: GET /r/:code
router.get('/r/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const link = await shortenerStore.findByCode(code);
    if (!link) {
      return res.status(404).json({ error: '해당 코드의 URL을 찾을 수 없습니다.' });
    }

    await shortenerStore.incrementHit(code);

    return res.redirect(302, link.originalUrl);
  } catch (err) {
    console.error('[GET /r/:code] error:', err);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// 3) 링크 목록 조회: GET /links
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
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

export default router;
