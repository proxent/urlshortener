import { createApp } from './app';
import { shortenerStore } from './shortenerStore';
import { config } from './config';

const app = createApp({ store: shortenerStore });

app.listen(config.PORT, () => {
  console.log(`🚀 Server running on ${config.BASE_URL || `http://localhost:${config.PORT}`}`);
});
