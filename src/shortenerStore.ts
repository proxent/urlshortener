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

interface PrismaShortenerStoreOptions {
  hitCountFlushIntervalMs?: number;
  maxPendingHitUpdates?: number;
}

const DEFAULT_HIT_COUNT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_PENDING_HIT_UPDATES = 1024;

export class PrismaShortenerStore {
  private readonly client: typeof prisma;
  private readonly generateCode: () => string;
  private readonly hitCountFlushIntervalMs: number;
  private readonly maxPendingHitUpdates: number;
  private pendingHitUpdates = new Map<string, number>();
  private hitFlushTimer: NodeJS.Timeout | null = null;
  private hitFlushInFlight: Promise<void> | null = null;

  constructor(
    client: typeof prisma = prisma,
    generateCode: () => string = () => nanoid(8),
    options: PrismaShortenerStoreOptions = {},
  ) {
    this.client = client;
    this.generateCode = generateCode;
    this.hitCountFlushIntervalMs = Math.max(
      1,
      options.hitCountFlushIntervalMs ?? DEFAULT_HIT_COUNT_FLUSH_INTERVAL_MS,
    );
    this.maxPendingHitUpdates = Math.max(
      1,
      options.maxPendingHitUpdates ?? DEFAULT_MAX_PENDING_HIT_UPDATES,
    );
  }

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
    this.pendingHitUpdates.set(code, (this.pendingHitUpdates.get(code) ?? 0) + 1);

    if (this.pendingHitUpdates.size >= this.maxPendingHitUpdates) {
      await this.flushPendingHits();
      return;
    }

    this.scheduleHitFlush();
  }

  async getAll(): Promise<ShortLink[]> {
    return observeStoreOperation('getAll', () =>
      this.client.url.findMany({
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async flushPendingHits(): Promise<void> {
    if (this.hitFlushInFlight) {
      await this.hitFlushInFlight;

      if (this.pendingHitUpdates.size > 0) {
        await this.flushPendingHits();
      }

      return;
    }

    if (this.pendingHitUpdates.size === 0) {
      return;
    }

    this.clearScheduledHitFlush();

    const batch = this.pendingHitUpdates;
    this.pendingHitUpdates = new Map();

    const flushPromise = observeStoreOperation('flushPendingHits', async () => {
      await this.client.$transaction(
        Array.from(batch.entries(), ([pendingCode, incrementBy]) =>
          this.client.url.update({
            where: { code: pendingCode },
            data: {
              hitCount: {
                increment: incrementBy,
              },
            },
          }),
        ),
      );
    });

    this.hitFlushInFlight = flushPromise;

    try {
      await flushPromise;
    } catch (error) {
      this.mergePendingHitUpdates(batch);
      throw error;
    } finally {
      this.hitFlushInFlight = null;
    }

    if (this.pendingHitUpdates.size > 0) {
      this.scheduleHitFlush(0);
    }
  }

  private scheduleHitFlush(delayMs = this.hitCountFlushIntervalMs): void {
    if (this.hitFlushTimer) {
      return;
    }

    this.hitFlushTimer = setTimeout(() => {
      this.hitFlushTimer = null;
      void this.flushPendingHits().catch((error) => {
        console.error('[PrismaShortenerStore] flushPendingHits error:', error);
      });
    }, delayMs);

    this.hitFlushTimer.unref?.();
  }

  private clearScheduledHitFlush(): void {
    if (!this.hitFlushTimer) {
      return;
    }

    clearTimeout(this.hitFlushTimer);
    this.hitFlushTimer = null;
  }

  private mergePendingHitUpdates(batch: ReadonlyMap<string, number>): void {
    for (const [code, incrementBy] of batch.entries()) {
      this.pendingHitUpdates.set(code, (this.pendingHitUpdates.get(code) ?? 0) + incrementBy);
    }
  }
}

export const shortenerStore = new PrismaShortenerStore();
