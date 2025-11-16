import path from 'path';
import express from 'express';
import router from './routes';
import { errorHandler } from './middleware/errorHandler';
import { config } from './config';

const app = express();

app.use(express.static(path.join(__dirname, '../public')));

app.use(express.json());

// Routes
app.use('/', router);

// Error Handler (Express 5 style)
app.use(errorHandler);

app.listen(config.PORT, () => {
  console.log(`🚀 Server running on ${config.BASE_URL || `http://localhost:${config.PORT}`}`);
});
