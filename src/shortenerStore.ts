// src/shortenerStore.ts
import { nanoid } from 'nanoid';
import { observeStoreOperation, observeUniqueCodeAttempts } from './metrics';
import { prisma } from './prisma';

export interface ShortLink {
  id: number;
  originalUrl: string;
  code: string;
  createdAt: Date;
  hitCount: number;
}

class PrismaShortenerStore {
  async checkReadiness(): Promise<void> {
    await observeStoreOperation('checkReadiness', async () => {
      await prisma.$queryRaw`SELECT 1`;
    });
  }

  async create(originalUrl: string): Promise<ShortLink> {
    return observeStoreOperation('create', async () => {
      const link = await prisma.url.create({
        data: {
          originalUrl,
          code: await this.generateUniqueCode(),
        },
      });

      return link;
    });
  }

  private async generateUniqueCode(): Promise<string> {
    return observeStoreOperation('generateUniqueCode', async () => {
      let attempts = 0;

      while (true) {
        attempts += 1;
        const code = nanoid(8);
        const existing = await prisma.url.findUnique({ where: { code } });
        if (!existing) {
          observeUniqueCodeAttempts(attempts);
          return code;
        }
      }
    });
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    return observeStoreOperation('findByCode', () =>
      prisma.url.findUnique({
        where: { code },
      }),
    );
  }

  async incrementHit(code: string): Promise<void> {
    await observeStoreOperation('incrementHit', async () => {
      await prisma.url.update({
        where: { code },
        data: {
          hitCount: {
            increment: 1,
          },
        },
      });
    });
  }

  async getAll(): Promise<ShortLink[]> {
    return observeStoreOperation('getAll', () =>
      prisma.url.findMany({
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}

export const shortenerStore = new PrismaShortenerStore();
