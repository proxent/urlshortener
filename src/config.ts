// src/config.ts
import 'dotenv/config';

type NodeEnv = 'development' | 'production' | 'test';
type TrustProxy = boolean | number | string;

const NODE_ENV = (process.env.NODE_ENV as NodeEnv) || 'development';
const PORT = Number(process.env.PORT || 3000);

const BASE_URL =
  process.env.BASE_URL || (NODE_ENV === 'production' ? undefined : `http://localhost:${PORT}`);

const DATABASE_URL = process.env.DATABASE_URL;

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const RATE_LIMIT_MAX_SHORTEN = parsePositiveInt(process.env.RATE_LIMIT_MAX_SHORTEN, 60);
const LOADTEST_BYPASS_KEY = process.env.LOADTEST_BYPASS_KEY || '';

const parseTrustProxy = (value: string | undefined): TrustProxy | undefined => {
  if (!value) return undefined;

  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
};

const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY || (NODE_ENV === 'production' ? '1' : undefined));

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
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_SHORTEN,
  LOADTEST_BYPASS_KEY,
  TRUST_PROXY,
};
