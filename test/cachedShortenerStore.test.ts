import test from 'node:test';
import assert from 'node:assert/strict';
import { CachedShortenerStore } from '../src/cachedShortenerStore';
import type { AppStoreLike } from '../src/app';
import type { RedirectTarget, ShortLink } from '../src/routes';

const buildLink = (code: string, originalUrl = `https://example.com/${code}`): ShortLink => ({
  id: Number(code.replace(/\D/g, '')) || 1,
  originalUrl,
  code,
  createdAt: new Date(),
  hitCount: 0,
});

class CountingStore implements AppStoreLike {
  public findCalls = 0;

  constructor(private readonly links = new Map<string, ShortLink>()) {}

  async checkReadiness(): Promise<void> {}

  async create(originalUrl: string): Promise<ShortLink> {
    const link = buildLink(`code${this.links.size + 1}`, originalUrl);
    this.links.set(link.code, link);
    return link;
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    this.findCalls += 1;
    return this.links.get(code) ?? null;
  }

  async findRedirectTargetByCode(code: string): Promise<RedirectTarget | null> {
    this.findCalls += 1;
    const link = this.links.get(code);
    if (!link) {
      return null;
    }

    return {
      code: link.code,
      originalUrl: link.originalUrl,
    };
  }

  async incrementHit(code: string): Promise<void> {
    const link = this.links.get(code);
    if (link) {
      link.hitCount += 1;
    }
  }

  async getAll(): Promise<ShortLink[]> {
    return [...this.links.values()];
  }
}

test('findRedirectTargetByCode returns cached targets without hitting the backing store twice', async () => {
  const backingStore = new CountingStore(new Map([['code1', buildLink('code1')]]));
  const store = new CachedShortenerStore(backingStore, 100);

  const first = await store.findRedirectTargetByCode('code1');
  const second = await store.findRedirectTargetByCode('code1');

  assert.ok(first);
  assert.ok(second);
  assert.equal(backingStore.findCalls, 1);
  assert.equal(second.originalUrl, 'https://example.com/code1');
});

test('create warms the redirect cache for the new short code', async () => {
  const backingStore = new CountingStore();
  const store = new CachedShortenerStore(backingStore, 100);

  const created = await store.create('https://example.com/docs');
  const fetched = await store.findRedirectTargetByCode(created.code);

  assert.ok(fetched);
  assert.equal(fetched.code, created.code);
  assert.equal(backingStore.findCalls, 0);
});

test('cache evicts the oldest entry when max entries is exceeded', async () => {
  const backingStore = new CountingStore(
    new Map([
      ['code1', buildLink('code1')],
      ['code2', buildLink('code2')],
      ['code3', buildLink('code3')],
    ]),
  );
  const store = new CachedShortenerStore(backingStore, 2);

  await store.findRedirectTargetByCode('code1');
  await store.findRedirectTargetByCode('code2');
  await store.findRedirectTargetByCode('code3');
  await store.findRedirectTargetByCode('code2');
  await store.findRedirectTargetByCode('code1');

  assert.equal(backingStore.findCalls, 4);
});
