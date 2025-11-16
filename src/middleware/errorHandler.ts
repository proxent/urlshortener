import type { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error('Error:', err);

  res.status(500).json({
    error: true,
    message: err.message ?? 'Internal Server Error',
  });
};
