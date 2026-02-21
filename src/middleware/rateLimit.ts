import crypto from 'crypto';
import type { Request } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';

const RATE_LIMIT_BYPASS_HEADER = 'x-loadtest-key';

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const isBypassRequest = (req: Request): boolean => {
  const bypassKey = config.LOADTEST_BYPASS_KEY;
  if (!bypassKey) {
    return false;
  }

  const providedKey = req.header(RATE_LIMIT_BYPASS_HEADER);
  if (!providedKey) {
    return false;
  }

  return safeEqual(providedKey, bypassKey);
};

export const shortenRateLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_MAX_SHORTEN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
  skip: (req) => isBypassRequest(req),
});
