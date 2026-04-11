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
