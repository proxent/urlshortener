// src/config.ts
import 'dotenv/config';

type NodeEnv = 'development' | 'production' | 'test';

const NODE_ENV = (process.env.NODE_ENV as NodeEnv) || 'development';
const PORT = Number(process.env.PORT || 3000);

const BASE_URL =
  process.env.BASE_URL || (NODE_ENV === 'production' ? undefined : `http://localhost:${PORT}`);

const DATABASE_URL = process.env.DATABASE_URL;

if (!BASE_URL) {
  // Warn when BASE_URL is missing in a deployed environment
  console.warn('[config] BASE_URL is not set. Some features may not generate full URLs.');
}

// Uncomment below if you want to enforce DATABASE_URL when using DB
// if (!DATABASE_URL) {
//   throw new Error('DATABASE_URL is not set');
// }

export const config = {
  NODE_ENV,
  PORT,
  BASE_URL,
  DATABASE_URL,
};
