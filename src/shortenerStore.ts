// src/shortenerStore.ts
import { prisma } from './prisma';
import { nanoid } from 'nanoid';
export interface ShortLink {
  id: number;
  originalUrl: string;
  code: string;
  createdAt: Date;
  hitCount: number;
}

class PrismaShortenerStore {
  async checkReadiness(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;
  }

  async create(originalUrl: string): Promise<ShortLink> {
    const link = await prisma.url.create({
      data: {
        originalUrl,
        code: await this.generateUniqueCode(),
      },
    });

    return link;
  }

  private async generateUniqueCode(): Promise<string> {
    while (true) {
      const code = nanoid(8);
      const existing = await prisma.url.findUnique({ where: { code } });
      if (!existing) return code;
    }
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    return prisma.url.findUnique({
      where: { code },
    });
  }

  async incrementHit(code: string): Promise<void> {
    await prisma.url.update({
      where: { code },
      data: {
        hitCount: {
          increment: 1,
        },
      },
    });
  }

  async getAll(): Promise<ShortLink[]> {
    return prisma.url.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }
}

export const shortenerStore = new PrismaShortenerStore();
