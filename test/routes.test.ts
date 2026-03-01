import test from 'node:test';
import assert from 'node:assert/strict';
import type { Router, RequestHandler } from 'express';
import { createRouter, type ShortLink, type ShortenerStoreLike } from '../src/routes';

class InMemoryStore implements ShortenerStoreLike {
  private links: ShortLink[] = [];

  async create(originalUrl: string): Promise<ShortLink> {
    const code = `code${this.links.length + 1}`;
    const link: ShortLink = {
      id: this.links.length + 1,
      originalUrl,
      code,
      createdAt: new Date(),
      hitCount: 0,
    };

    this.links.unshift(link);
    return link;
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    return this.links.find((link) => link.code === code) ?? null;
  }

  async incrementHit(code: string): Promise<void> {
    const link = this.links.find((item) => item.code === code);
    if (link) {
      link.hitCount += 1;
    }
  }

  async getAll(): Promise<ShortLink[]> {
    return this.links;
  }
}

type MockReq = {
  body?: unknown;
  params?: Record<string, string>;
  header?: (name: string) => string | undefined;
};

type MockRes = {
  statusCode: number;
  jsonBody?: unknown;
  redirectCode?: number;
  redirectUrl?: string;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  redirect: (status: number, url: string) => MockRes;
};

const createMockRes = (): MockRes => {
  const res: MockRes = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    redirect(status: number, url: string) {
      res.redirectCode = status;
      res.redirectUrl = url;
      return res;
    },
  };

  return res;
};

const invokeRoute = async ({
  router,
  method,
  path,
  req,
  res,
}: {
  router: Router;
  method: 'post' | 'get';
  path: string;
  req: MockReq;
  res: MockRes;
}) => {
  const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: RequestHandler }> } }> }).stack.find(
    (item) => item.route?.path === path && item.route.methods[method],
  );

  assert.ok(layer?.route, `Route ${method.toUpperCase()} ${path} not found`);
  const handlers = layer.route.stack.map((entry) => entry.handle);

  for (const handler of handlers) {
    await new Promise<void>((resolve, reject) => {
      const next = (err?: unknown) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };

      try {
        const maybePromise = handler(req as never, res as never, next) as unknown;
        if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === 'function') {
          (maybePromise as PromiseLike<unknown>).then(
            () => resolve(),
            (err) => reject(err),
          );
        }
      } catch (err) {
        reject(err);
      }
    });
  }
};

const noOpRateLimiter: RequestHandler = (_req, _res, next) => next();

test('POST /shorten returns 400 for invalid payload', async () => {
  const store = new InMemoryStore();
  const router = createRouter({ store, shortenRateLimiter: noOpRateLimiter });
  const res = createMockRes();

  await invokeRoute({
    router,
    method: 'post',
    path: '/shorten',
    req: { body: { url: 'not-a-url' } },
    res,
  });

  assert.equal(res.statusCode, 400);
  assert.match(String((res.jsonBody as { error: string }).error), /valid URL/i);
});

test('POST /shorten returns 400 for non-http protocol', async () => {
  const store = new InMemoryStore();
  const router = createRouter({ store, shortenRateLimiter: noOpRateLimiter });
  const res = createMockRes();

  await invokeRoute({
    router,
    method: 'post',
    path: '/shorten',
    req: { body: { url: 'javascript:alert(1)' } },
    res,
  });

  assert.equal(res.statusCode, 400);
  assert.match(String((res.jsonBody as { error: string }).error), /valid URL/i);
});

test('POST /shorten returns 400 for too long url', async () => {
  const store = new InMemoryStore();
  const router = createRouter({ store, shortenRateLimiter: noOpRateLimiter });
  const res = createMockRes();
  const longPath = 'a'.repeat(2050);

  await invokeRoute({
    router,
    method: 'post',
    path: '/shorten',
    req: { body: { url: `https://example.com/${longPath}` } },
    res,
  });

  assert.equal(res.statusCode, 400);
  assert.match(String((res.jsonBody as { error: string }).error), /valid URL/i);
});

test('POST /shorten creates short url', async () => {
  const store = new InMemoryStore();
  const router = createRouter({ store, shortenRateLimiter: noOpRateLimiter });
  const res = createMockRes();

  await invokeRoute({
    router,
    method: 'post',
    path: '/shorten',
    req: { body: { url: 'https://example.com/docs' } },
    res,
  });

  const body = res.jsonBody as { originalUrl: string; code: string; shortUrl: string };

  assert.equal(res.statusCode, 201);
  assert.equal(body.originalUrl, 'https://example.com/docs');
  assert.equal(body.code, 'code1');
  assert.ok(body.shortUrl.endsWith('/r/code1'));
});

test('GET /r/:code redirects and increments hit count', async () => {
  const store = new InMemoryStore();
  const created = await store.create('https://example.com/redirect-target');
  const router = createRouter({ store, shortenRateLimiter: noOpRateLimiter });
  const res = createMockRes();

  await invokeRoute({
    router,
    method: 'get',
    path: '/r/:code',
    req: { params: { code: created.code } },
    res,
  });

  assert.equal(res.redirectCode, 302);
  assert.equal(res.redirectUrl, 'https://example.com/redirect-target');
  const updated = await store.findByCode(created.code);
  assert.ok(updated);
  assert.equal(updated.hitCount, 1);
});

test('GET /r/:code returns 404 for unknown code', async () => {
  const store = new InMemoryStore();
  const router = createRouter({ store, shortenRateLimiter: noOpRateLimiter });
  const res = createMockRes();

  await invokeRoute({
    router,
    method: 'get',
    path: '/r/:code',
    req: { params: { code: 'missing' } },
    res,
  });

  assert.equal(res.statusCode, 404);
});
