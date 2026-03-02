// src/config.ts
import 'dotenv/config';

type NodeEnv = 'development' | 'production' | 'test';
type TrustProxy = boolean | number | string;
const ALLOWED_BASE_URL_PROTOCOLS = new Set(['http:', 'https:']);
const PRODUCTION_BLOCKED_BASE_URL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const NODE_ENV = (process.env.NODE_ENV as NodeEnv) || 'development';
const PORT = Number(process.env.PORT || 3000);

const BASE_URL =
  process.env.BASE_URL || (NODE_ENV === 'production' ? undefined : `http://localhost:${PORT}`);

const validateBaseUrl = (value: string): void => {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[config] BASE_URL must be a valid absolute URL.');
  }

  if (!ALLOWED_BASE_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('[config] BASE_URL must use http or https.');
  }

  if (NODE_ENV === 'production' && PRODUCTION_BLOCKED_BASE_URL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error('[config] BASE_URL cannot point to localhost in production.');
  }
};

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

const TRUST_PROXY = parseTrustProxy(
  process.env.TRUST_PROXY || (NODE_ENV === 'production' ? '1' : undefined),
);

if (NODE_ENV === 'production' && !BASE_URL) {
  throw new Error('[config] BASE_URL is required in production.');
}

if (BASE_URL) {
  validateBaseUrl(BASE_URL);
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
