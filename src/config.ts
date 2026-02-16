import 'dotenv/config';

type NodeEnv = 'development' | 'production' | 'test';

const NODE_ENV = (process.env.NODE_ENV as NodeEnv) || 'development';
const PORT = Number(process.env.PORT || 3000);

const BASE_URL =
  process.env.BASE_URL || (NODE_ENV === 'production' ? undefined : `http://localhost:${PORT}`);

const DATABASE_URL = process.env.DATABASE_URL;

if (!BASE_URL) {
  console.warn('[config] BASE_URL is not set. Some features may not generate full URLs.');
}

export const config = {
  NODE_ENV,
  PORT,
  BASE_URL,
  DATABASE_URL,
};
