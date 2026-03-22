import type { Request, RequestHandler } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({
  service: 'url-shortener',
});

collectDefaultMetrics({
  register: metricsRegistry,
  eventLoopMonitoringPrecision: 10,
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [metricsRegistry],
});

const getRouteLabel = (req: Request): string => {
  if (typeof req.route?.path === 'string') {
    return `${req.baseUrl || ''}${req.route.path}` || req.route.path;
  }

  return `${req.baseUrl || ''}${req.path || 'unmatched'}` || 'unmatched';
};

export const prometheusMiddleware: RequestHandler = (req, res, next) => {
  if (req.path === '/metrics') {
    return next();
  }

  const endTimer = httpRequestDuration.startTimer();

  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: getRouteLabel(req),
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    endTimer(labels);
  });

  next();
};

export const metricsHandler: RequestHandler = async (_req, res, next) => {
  try {
    res.setHeader('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    next(error);
  }
};
