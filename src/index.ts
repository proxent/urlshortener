import { createApp } from './app';
import { CachedShortenerStore } from './cachedShortenerStore';
import { shortenerStore } from './shortenerStore';
import { config } from './config';

const app = createApp({
  store: new CachedShortenerStore(shortenerStore, config.REDIRECT_CACHE_MAX_ENTRIES),
});

const server = app.listen(config.PORT, () => {
  console.log(`🚀 Server running on ${config.BASE_URL || `http://localhost:${config.PORT}`}`);
});

server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;
