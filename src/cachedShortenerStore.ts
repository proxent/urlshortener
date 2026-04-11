import type { AppStoreLike } from './app';
import type { ShortLink } from './routes';

export class CachedShortenerStore implements AppStoreLike {
  private readonly redirectCache = new Map<string, ShortLink>();

  constructor(
    private readonly store: AppStoreLike,
    private readonly maxEntries: number,
  ) {}

  async checkReadiness(): Promise<void> {
    await this.store.checkReadiness();
  }

  async create(originalUrl: string): Promise<ShortLink> {
    const link = await this.store.create(originalUrl);
    this.cacheLink(link);
    return link;
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    const cached = this.redirectCache.get(code);
    if (cached) {
      this.redirectCache.delete(code);
      this.redirectCache.set(code, cached);
      return cached;
    }

    const link = await this.store.findByCode(code);
    if (link) {
      this.cacheLink(link);
    }

    return link;
  }

  async incrementHit(code: string): Promise<void> {
    const cached = this.redirectCache.get(code);
    if (cached) {
      cached.hitCount += 1;
    }

    await this.store.incrementHit(code);
  }

  async getAll(): Promise<ShortLink[]> {
    return this.store.getAll();
  }

  private cacheLink(link: ShortLink): void {
    this.redirectCache.delete(link.code);
    this.redirectCache.set(link.code, { ...link });

    if (this.redirectCache.size <= this.maxEntries) {
      return;
    }

    const oldestCode = this.redirectCache.keys().next().value;
    if (oldestCode) {
      this.redirectCache.delete(oldestCode);
    }
  }
}
