// src/config.ts
import 'dotenv/config';

type NodeEnv = 'development' | 'production' | 'test';

const NODE_ENV = (process.env.NODE_ENV as NodeEnv) || 'development';
const PORT = Number(process.env.PORT || 3000);

const BASE_URL =
  process.env.BASE_URL || (NODE_ENV === 'production' ? undefined : `http://localhost:${PORT}`);

const DATABASE_URL = process.env.DATABASE_URL;

if (!BASE_URL) {
  // 배포 환경인데 BASE_URL이 없으면 경고
  console.warn('[config] BASE_URL is not set. Some features may not generate full URLs.');
}

// DB 붙일 때 강제하고 싶으면 아래 주석 해제 예정
// if (!DATABASE_URL) {
//   throw new Error('DATABASE_URL is not set');
// }

export const config = {
  NODE_ENV,
  PORT,
  BASE_URL,
  DATABASE_URL,
};
