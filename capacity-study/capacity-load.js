import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

const seedPrefix = 'https://bench.invalid/seed/';
const phase = __ENV.BENCHMARK_PHASE;
const targets = (__ENV.TARGET || '').split(',');
if (targets.length !== 2 || !targets.every((origin) => /^http:\/\/127\.0\.0\.1:[1-9]\d+$/.test(origin)) || !['warmup', 'measure'].includes(phase)) {
  throw new Error('Supply the two local lab origins as TARGET and set BENCHMARK_PHASE to warmup or measure.');
}

function integer(name, min, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(__ENV[name]);
  if (!/^\d+$/.test(__ENV[name] || '') || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(name + ' must be an integer in [' + min + ', ' + max + '].');
  }
  return value;
}

const workloadSeed = integer('BENCHMARK_SEED', 0, 0xffffffff);
const phaseSalt = phase === 'warmup' ? 0x66756a3b : 0;
const duration = integer('BENCHMARK_SECONDS', 1);
const redirectRate = integer('REDIRECT_RPS', 1);
const shortenRate = integer('SHORTEN_RPS', 1);
const redirectVus = integer('REDIRECT_VUS', 1);
const shortenVus = integer('SHORTEN_VUS', 1);
const expectedRedirects = redirectRate * duration;
const expectedShortens = shortenRate * duration;
if (![expectedRedirects, expectedShortens].every(Number.isSafeInteger)) {
  throw new Error('The scheduled request counts exceed the exact integer range.');
}
const hotFraction = Number(__ENV.HOT_RATIO ?? '0.6');
const hotSetFraction = Number(__ENV.HOT_SET_PCT ?? '0.01');
if (!(hotFraction >= 0 && hotFraction <= 1 && hotSetFraction > 0 && hotSetFraction < 1)) {
  throw new Error('Supply valid HOT_RATIO and HOT_SET_PCT fractions.');
}

const codes = new SharedArray('benchmark short codes', () => {
  const list = JSON.parse(open(__ENV.SEED_FILE));
  if (!Array.isArray(list) || list.length < 2 ||
    list.some((code) => typeof code !== 'string' || !/^[\w-]{8}$/.test(code)) || new Set(list).size !== list.length) {
    throw new Error('SEED_FILE must contain at least two unique eight-character short codes.');
  }
  return list;
});
const hotCount = Math.min(codes.length - 1, Math.max(1, Math.floor(codes.length * hotSetFraction)));
const redirects = new Counter('benchmark_redirect_completed');
const shortens = new Counter('benchmark_shorten_completed');
const redirectSuccess = new Rate('benchmark_redirect_success');
const shortenSuccess = new Rate('benchmark_shorten_success');
const redirectLatency = new Trend('benchmark_redirect_latency_ms', true);
const redirectServiceLatency = new Trend('benchmark_redirect_http_ms', true);
const shortenServiceLatency = new Trend('benchmark_shorten_http_ms', true);
const shortenLatency = new Trend('benchmark_shorten_latency_ms', true);

function scenario(rate, vus, handler) {
  return {
    executor: 'constant-arrival-rate',
    duration: duration + 's',
    timeUnit: '1s',
    rate,
    preAllocatedVUs: vus,
    maxVUs: vus,
    gracefulStop: '11s',
    exec: handler,
  };
}

const thresholds = {
  dropped_iterations: ['count==0'],
  benchmark_redirect_completed: ['count==' + expectedRedirects],
  benchmark_shorten_completed: ['count==' + expectedShortens],
  benchmark_redirect_success: ['rate>0.99'],
  benchmark_shorten_success: ['rate>0.99'],
};
if (phase === 'measure') {
  thresholds.benchmark_redirect_latency_ms = ['p(95)<100', 'p(99)<250'];
  thresholds.benchmark_shorten_latency_ms = ['p(95)<300', 'p(99)<800'];
}
export const options = {
  maxRedirects: 0,
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)'],
  thresholds,
  scenarios: {
    redirects: scenario(redirectRate, redirectVus, 'redirect'),
    shortens: scenario(shortenRate, shortenVus, 'shorten'),
  },
};

export function setup() {
  for (const [replica, target] of targets.entries()) {
    const code = replica === 0 ? codes[0] : codes[codes.length - 1];
    const response = http.get(target + '/r/' + code, { timeout: '3s', tags: { phase: 'verify' } });
    if (response.status !== 302 || response.headers.Location !== seedPrefix + code) {
      exec.test.abort('The target did not return the expected synthetic seed links.');
    }
  }
}

function workloadRandom(stream) {
  // Key random choices by iteration, so VU assignment does not change the trace.
  let x = workloadSeed ^ phaseSalt ^ Math.imul(exec.scenario.iterationInTest + 1, 0x9e3779b1) ^ stream;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 0x100000000;
}

export function redirect() {
  // An executor can start one last iteration at the terminal boundary.
  if (exec.scenario.iterationInTest >= expectedRedirects) return;
  const hot = workloadRandom(1) < hotFraction;
  const index = hot ? Math.floor(workloadRandom(2) * hotCount)
    : hotCount + Math.floor(workloadRandom(2) * (codes.length - hotCount));
  const code = codes[index];
  const target = targets[exec.scenario.iterationInTest % targets.length];
  const start = Date.now();
  const response = http.get(target + '/r/' + code, { timeout: '10s', tags: { phase, name: 'GET /r/:code' } });
  redirectLatency.add(Date.now() - start);
  redirectServiceLatency.add(response.timings.duration);
  redirects.add(1);
  redirectSuccess.add(response.status === 302 && response.headers.Location === seedPrefix + code);
}

export function shorten() {
  if (exec.scenario.iterationInTest >= expectedShortens) return;
  const url = 'https://bench.invalid/new/' + phase + '/' + workloadSeed + '/' + exec.scenario.iterationInTest;
  const params = { headers: { 'Content-Type': 'application/json' }, responseType: 'text',
    timeout: '10s', tags: { phase, name: 'POST /shorten' } };
  if (__ENV.LOADTEST_BYPASS_KEY) params.headers['x-loadtest-key'] = __ENV.LOADTEST_BYPASS_KEY;
  const target = targets[exec.scenario.iterationInTest % targets.length];
  const start = Date.now();
  const response = http.post(target + '/shorten', JSON.stringify({ url }), params);
  shortenLatency.add(Date.now() - start);
  shortenServiceLatency.add(response.timings.duration);
  shortens.add(1);
  let valid = false;
  if (response.status === 201) {
    try {
      const link = response.json();
      valid = link.originalUrl === url && typeof link.code === 'string' && /^[\w-]{8}$/.test(link.code);
    } catch {
      valid = false;
    }
  }
  shortenSuccess.add(valid);
}


