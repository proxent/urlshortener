// src/shortenerStore.ts
import { Prisma } from '@prisma/client';
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

export class PrismaShortenerStore {
  constructor(
    private readonly client: typeof prisma = prisma,
    private readonly generateCode: () => string = () => nanoid(8),
  ) {}

  async checkReadiness(): Promise<void> {
    await observeStoreOperation('checkReadiness', async () => {
      await this.client.$queryRaw`SELECT 1`;
    });
  }

  async create(originalUrl: string): Promise<ShortLink> {
    return observeStoreOperation('create', async () => {
      let attempts = 0;

      while (true) {
        attempts += 1;
        const code = await this.generateUniqueCode();

        try {
          const link = await this.client.url.create({
            data: {
              originalUrl,
              code,
            },
          });

          observeUniqueCodeAttempts(attempts);
          return link;
        } catch (error) {
          if (this.isUniqueCodeConflict(error)) {
            continue;
          }

          throw error;
        }
      }
    });
  }

  private async generateUniqueCode(): Promise<string> {
    return observeStoreOperation('generateUniqueCode', async () => {
      return this.generateCode();
    });
  }

  private isUniqueCodeConflict(error: unknown): boolean {
    const errorWithCode =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }) : null;

    return (
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002') ||
      errorWithCode?.code === 'P2002'
    );
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    return observeStoreOperation('findByCode', () =>
      this.client.url.findUnique({
        where: { code },
      }),
    );
  }

  async incrementHit(code: string): Promise<void> {
    await observeStoreOperation('incrementHit', async () => {
      await this.client.url.update({
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
      this.client.url.findMany({
        orderBy: { createdAt: 'desc' },
      }),
    );
  }
}

export const shortenerStore = new PrismaShortenerStore();
