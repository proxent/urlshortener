import type { AppStoreLike } from './app';
import type { RedirectTarget, ShortLink } from './routes';

export class CachedShortenerStore implements AppStoreLike {
  private readonly redirectCache = new Map<string, RedirectTarget>();

  constructor(
    private readonly store: AppStoreLike,
    private readonly maxEntries: number,
  ) {}

  async checkReadiness(): Promise<void> {
    await this.store.checkReadiness();
  }

  async create(originalUrl: string): Promise<ShortLink> {
    const link = await this.store.create(originalUrl);
    this.cacheRedirectTarget(link);
    return link;
  }

  async findRedirectTargetByCode(code: string): Promise<RedirectTarget | null> {
    const cached = this.redirectCache.get(code);
    if (cached) {
      this.redirectCache.delete(code);
      this.redirectCache.set(code, cached);
      return cached;
    }

    const redirectTarget = await this.store.findRedirectTargetByCode(code);
    if (redirectTarget) {
      this.cacheRedirectTarget(redirectTarget);
    }

    return redirectTarget;
  }

  async findByCode(code: string): Promise<ShortLink | null> {
    const link = await this.store.findByCode(code);
    if (link) {
      this.cacheRedirectTarget(link);
    }

    return link;
  }

  async incrementHit(code: string): Promise<void> {
    await this.store.incrementHit(code);
  }

  async getAll(): Promise<ShortLink[]> {
    return this.store.getAll();
  }

  private cacheRedirectTarget(target: RedirectTarget): void {
    this.redirectCache.delete(target.code);
    this.redirectCache.set(target.code, {
      code: target.code,
      originalUrl: target.originalUrl,
    });

    if (this.redirectCache.size <= this.maxEntries) {
      return;
    }

    const oldestCode = this.redirectCache.keys().next().value;
    if (oldestCode) {
      this.redirectCache.delete(oldestCode);
    }
  }
}
