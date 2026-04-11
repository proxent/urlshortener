import test from 'node:test';
import assert from 'node:assert/strict';
import type { ShortLink } from '../src/shortenerStore';
import { PrismaShortenerStore } from '../src/shortenerStore';
import { prisma } from '../src/prisma';

test('create retries when generated code collides on unique constraint', async () => {
  const createdCodes: string[] = [];
  const fakeLink: ShortLink = {
    id: 1,
    originalUrl: 'https://example.com/docs',
    code: 'secondtry',
    createdAt: new Date(),
    hitCount: 0,
  };

  const fakePrisma = {
    $queryRaw: async () => 1,
    url: {
      create: async ({ data }: { data: { originalUrl: string; code: string } }) => {
        createdCodes.push(data.code);

        if (data.code === 'firsttry') {
          throw { code: 'P2002' };
        }

        return { ...fakeLink, code: data.code, originalUrl: data.originalUrl };
      },
      findUnique: async () => null,
      update: async () => undefined,
      findMany: async () => [],
    },
  } as unknown as typeof prisma;

  const codes = ['firsttry', 'secondtry'];
  const store = new PrismaShortenerStore(fakePrisma, () => {
    const code = codes.shift();
    assert.ok(code, 'expected another generated code');
    return code;
  });

  const link = await store.create('https://example.com/docs');

  assert.equal(link.code, 'secondtry');
  assert.deepEqual(createdCodes, ['firsttry', 'secondtry']);
});

test('findRedirectTargetByCode selects only redirect fields', async () => {
  const fakePrisma = {
    $queryRaw: async () => 1,
    $transaction: async <T>(operations: Promise<T>[]) => Promise.all(operations),
    url: {
      create: async () => {
        throw new Error('not implemented');
      },
      findUnique: async ({ where, select }: { where: { code: string }; select?: Record<string, boolean> }) => {
        assert.deepEqual(where, { code: 'code1' });
        assert.deepEqual(select, {
          code: true,
          originalUrl: true,
        });

        return {
          code: 'code1',
          originalUrl: 'https://example.com/code1',
        };
      },
      update: async () => undefined,
      findMany: async () => [],
    },
  } as unknown as typeof prisma;

  const store = new PrismaShortenerStore(fakePrisma, () => 'unused');
  const redirectTarget = await store.findRedirectTargetByCode('code1');

  assert.deepEqual(redirectTarget, {
    code: 'code1',
    originalUrl: 'https://example.com/code1',
  });
});

test('incrementHit batches repeated updates for the same short code', async () => {
  const updates: Array<{ code: string; incrementBy: number }> = [];
  let transactionCalls = 0;

  const fakePrisma = {
    $queryRaw: async () => 1,
    $transaction: async <T>(operations: Promise<T>[]) => {
      transactionCalls += 1;
      return Promise.all(operations);
    },
    url: {
      create: async () => {
        throw new Error('not implemented');
      },
      findUnique: async () => null,
      update: async ({ where, data }: { where: { code: string }; data: { hitCount: { increment: number } } }) => {
        updates.push({ code: where.code, incrementBy: data.hitCount.increment });
      },
      findMany: async () => [],
    },
  } as unknown as typeof prisma;

  const store = new PrismaShortenerStore(fakePrisma, () => 'unused', {
    hitCountFlushIntervalMs: 60_000,
  });

  await store.incrementHit('code1');
  await store.incrementHit('code1');
  await store.incrementHit('code2');
  await store.flushPendingHits();

  assert.equal(transactionCalls, 1);
  assert.deepEqual(updates, [
    { code: 'code1', incrementBy: 2 },
    { code: 'code2', incrementBy: 1 },
  ]);
});

test('incrementHit flushes immediately when the pending batch reaches the limit', async () => {
  let transactionCalls = 0;

  const fakePrisma = {
    $queryRaw: async () => 1,
    $transaction: async <T>(operations: Promise<T>[]) => {
      transactionCalls += 1;
      return Promise.all(operations);
    },
    url: {
      create: async () => {
        throw new Error('not implemented');
      },
      findUnique: async () => null,
      update: async () => undefined,
      findMany: async () => [],
    },
  } as unknown as typeof prisma;

  const store = new PrismaShortenerStore(fakePrisma, () => 'unused', {
    hitCountFlushIntervalMs: 60_000,
    maxPendingHitUpdates: 2,
  });

  await store.incrementHit('code1');
  await store.incrementHit('code2');

  assert.equal(transactionCalls, 1);
});
