import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type AppStoreLike } from '../src/app';
import type { RedirectTarget, ShortLink } from '../src/routes';

class TestStore implements AppStoreLike {
  constructor(private readonly isReady: boolean) {}

  async checkReadiness(): Promise<void> {
    if (!this.isReady) {
      throw new Error('database unavailable');
    }
  }

  async create(_originalUrl: string): Promise<ShortLink> {
    throw new Error('Not implemented');
  }

  async findRedirectTargetByCode(_code: string): Promise<RedirectTarget | null> {
    throw new Error('Not implemented');
  }

  async findByCode(_code: string): Promise<ShortLink | null> {
    throw new Error('Not implemented');
  }

  async incrementHit(_code: string): Promise<void> {
    throw new Error('Not implemented');
  }

  async getAll(): Promise<ShortLink[]> {
    throw new Error('Not implemented');
  }
}

type MockRes = {
  statusCode: number;
  bodyText?: string;
  headers: Record<string, string>;
  jsonBody?: unknown;
  end: (body?: string) => MockRes;
  setHeader: (name: string, value: string) => MockRes;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
};

const createMockRes = (): MockRes => {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    end(body?: string) {
      res.bodyText = body;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };

  return res;
};

const invokeAppRoute = async (
  store: AppStoreLike,
  path: string,
): Promise<MockRes> => {
  const app = createApp({ store });
  const layer = (app as unknown as {
    router: {
      stack: Array<{
        route?: {
          path: string;
          methods: Record<string, boolean>;
          stack: Array<{ handle: (req: unknown, res: MockRes, next: (err?: unknown) => void) => unknown }>;
        };
      }>;
    };
  }).router.stack.find((item) => item.route?.path === path && item.route.methods.get);

  assert.ok(layer?.route, `Route GET ${path} not found`);

  const res = createMockRes();

  for (const handler of layer.route.stack.map((entry) => entry.handle)) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        callback();
      };

      const next = (err?: unknown) => {
        if (err) {
          finish(() => reject(err));
          return;
        }

        finish(resolve);
      };

      try {
        const maybePromise = handler({}, res, next);
        if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === 'function') {
          (maybePromise as PromiseLike<unknown>).then(
            () => finish(resolve),
            (err) => finish(() => reject(err)),
          );
          return;
        }

        finish(resolve);
      } catch (err) {
        finish(() => reject(err));
      }
    });
  }

  return res;
};

test('GET /healthz returns 200 even when the store is not ready', async () => {
  const response = await invokeAppRoute(new TestStore(false), '/healthz');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonBody, { status: 'ok' });
});

test('GET /readyz returns 200 when the store is ready', async () => {
  const response = await invokeAppRoute(new TestStore(true), '/readyz');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.jsonBody, { status: 'ready' });
});

test('GET /readyz returns 503 when the store is not ready', async () => {
  const response = await invokeAppRoute(new TestStore(false), '/readyz');

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.jsonBody, { status: 'not ready' });
});

test('GET /metrics exposes Prometheus metrics', async () => {
  const response = await invokeAppRoute(new TestStore(true), '/metrics');

  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/plain/);
  assert.match(response.bodyText ?? '', /process_cpu_user_seconds_total/);
  assert.match(response.bodyText ?? '', /# TYPE http_request_duration_seconds histogram/);
});
