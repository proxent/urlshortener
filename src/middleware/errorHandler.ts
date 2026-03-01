import type { ErrorRequestHandler } from 'express';
import { config } from '../config';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Error:', err);

  const errorMessage =
    config.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : err instanceof Error
        ? err.message
        : 'Internal Server Error';

  res.status(500).json({
    error: true,
    message: errorMessage,
  });
};
