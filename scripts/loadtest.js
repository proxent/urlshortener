import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

const SEED_FILE = __ENV.SEED_FILE || ''; // e.g. ./seed_codes.json

if (!SEED_FILE) {
  throw new Error('SEED_FILE is required. Restore the DB first, then provide a fixed seed file.');
}

const FILE_CODES = SEED_FILE
  ? new SharedArray('seed_codes', () => JSON.parse(open(SEED_FILE)))
  : null;

// --------------------
// Env (tweak here)
// --------------------
const TARGET = (__ENV.TARGET || 'http://localhost:3000').replace(/\/$/, '');
const LOADTEST_BYPASS_KEY = __ENV.LOADTEST_BYPASS_KEY || '';

// Total target RPS (redirect + shorten combined)
const BASE_RPS = parseInt(__ENV.BASE_RPS || '500', 10);
const SPIKE_MULT = parseFloat(__ENV.SPIKE_MULT || '3');

// Traffic mix
const REDIRECT_RATIO = parseFloat(__ENV.REDIRECT_RATIO || '0.98'); // 98%
const SHORTEN_RATIO = 1 - REDIRECT_RATIO;

// Hot key modeling
// - hot set size = HOT_SET_PCT of total codes
// - HOT_RATIO of redirects hit hot set (rest hit cold set)
const HOT_SET_PCT = parseFloat(__ENV.HOT_SET_PCT || '0.01'); // 1%
let HOT_RATIO = parseFloat(__ENV.HOT_RATIO || '0.6');        // 60% of redirects hit hot set

// Mode presets for cache experiments
// MODE=realistic (default): HOT_RATIO=0.6
// MODE=cold:      HOT_RATIO=0.0 (mostly uniform access to induce cache misses)
// MODE=warm:      HOT_RATIO=0.9 (repeat hot keys to induce cache hits)
const MODE = (__ENV.MODE || 'realistic').toLowerCase();
if (MODE === 'cold') HOT_RATIO = 0.0;
if (MODE === 'warm') HOT_RATIO = 0.9;

// VU allocation (arrival-rate requires enough VUs to keep up)
const PRE_VUS = parseInt(__ENV.PRE_VUS || '200', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '2000', 10);

if (!FILE_CODES || FILE_CODES.length === 0) {
  throw new Error(`Seed file is empty or unreadable: ${SEED_FILE}`);
}

const CODES = Array.from(FILE_CODES);
const HOT_CODE_COUNT = Math.max(1, Math.floor(CODES.length * HOT_SET_PCT));
const HOT_CODES = CODES.slice(0, HOT_CODE_COUNT);
const COLD_CODES = CODES.slice(HOT_CODE_COUNT);

const redirectSuccessRate = new Rate('redirect_success_rate');
const shortenSuccessRate = new Rate('shorten_success_rate');
const redirectStatusCount = new Counter('redirect_status_total');
const shortenStatusCount = new Counter('shorten_status_total');
const redirectDuration = new Trend('redirect_duration_ms');
const shortenDuration = new Trend('shorten_duration_ms');
const redirectWaiting = new Trend('redirect_waiting_ms');
const shortenWaiting = new Trend('shorten_waiting_ms');
const redirectConnecting = new Trend('redirect_connecting_ms');
const shortenConnecting = new Trend('shorten_connecting_ms');
const redirectTlsHandshaking = new Trend('redirect_tls_handshaking_ms');
const shortenTlsHandshaking = new Trend('shorten_tls_handshaking_ms');

// Prevent following redirects (measure only the 302 response)
export const options = (() => {
  const baseStages = [
    { target: BASE_RPS, duration: '30s' },                          // warm-up ramp
    { target: BASE_RPS, duration: '1m' },                         // steady
    { target: Math.floor(BASE_RPS * SPIKE_MULT), duration: '1m' }, // spike
    { target: BASE_RPS, duration: '1m' },                          // recovery
  ];

  // For cold/warm comparisons, you may want a longer steady run without spikes
  const steadyOnly = [
    { target: BASE_RPS, duration: '3m' },
    { target: BASE_RPS, duration: '12m' },
  ];

  const stages = (MODE === 'cold' || MODE === 'warm') ? steadyOnly : baseStages;

  return {
    maxRedirects: 0,
    // Keep logs free of generated response payloads; this benchmark only needs status/timing signals.
    discardResponseBodies: true,
    thresholds: {
      // Overall failure rate (redirect + shorten) — only for the run phase
      'http_req_failed{phase:run}': ['rate<0.01'],

      // Redirect SLO (tune numbers as you like)
      'http_req_duration{phase:run,endpoint:redirect}': ['p(95)<100', 'p(99)<250'],
      redirect_duration_ms: ['p(95)<100', 'p(99)<250'],
      redirect_waiting_ms: ['p(95)<100', 'p(99)<250'],
      redirect_success_rate: ['rate>0.99'],

      // Shorten SLO
      'http_req_duration{phase:run,endpoint:shorten}': ['p(95)<300', 'p(99)<800'],
      shorten_duration_ms: ['p(95)<300', 'p(99)<800'],
      shorten_waiting_ms: ['p(95)<300', 'p(99)<800'],
      shorten_success_rate: ['rate>0.99'],

      // If dropped iterations occur, the generator couldn't keep up (VU shortage / client-side bottleneck)
      'dropped_iterations{phase:run}': ['count==0'],
    },

    scenarios: {
      redirect_traffic: {
        executor: 'ramping-arrival-rate',
        startRate: 0,
        timeUnit: '1s',
        stages: stages.map(s => ({ ...s, target: Math.floor(s.target * REDIRECT_RATIO) })),
        preAllocatedVUs: PRE_VUS,
        maxVUs: MAX_VUS,
        exec: 'redirectExec',
      },
      shorten_traffic: {
        executor: 'ramping-arrival-rate',
        startRate: 0,
        timeUnit: '1s',
        stages: stages.map(s => ({ ...s, target: Math.max(1, Math.floor(s.target * SHORTEN_RATIO)) })),
        preAllocatedVUs: Math.max(10, Math.floor(PRE_VUS * 0.2)),
        maxVUs: Math.max(50, Math.floor(MAX_VUS * 0.3)),
        exec: 'shortenExec',
      },
    },
  };
})();

// --------------------
// Helpers
// --------------------
function randInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function pickCodeSkewed(codes, hotCodes, coldCodes) {
  if (hotCodes.length === 0) return codes[randInt(codes.length)];
  if (coldCodes.length === 0) return hotCodes[randInt(hotCodes.length)];

  // Pick from the hot set with probability HOT_RATIO
  if (Math.random() < HOT_RATIO) return hotCodes[randInt(hotCodes.length)];
  return coldCodes[randInt(coldCodes.length)];
}

function withBypassHeader(headers = {}) {
  if (!LOADTEST_BYPASS_KEY) return headers;
  return { ...headers, 'x-loadtest-key': LOADTEST_BYPASS_KEY };
}

// --------------------
// Redirect scenario
// --------------------
export function redirectExec() {
  const code = pickCodeSkewed(CODES, HOT_CODES, COLD_CODES);
  const url = `${TARGET}/r/${code}`;

  const res = http.get(url, {
    tags: { phase: 'run', endpoint: 'redirect' },
    redirects: 0,   // Measure only the 302 response
    timeout: '10s',
  });

  const success = check(res, {
    'redirect -> 302': (r) => r.status === 302,
    'redirect has Location': (r) => !!r.headers.Location,
  });

  redirectSuccessRate.add(success, { endpoint: 'redirect' });
  redirectStatusCount.add(1, { endpoint: 'redirect', status: String(res.status) });
  redirectDuration.add(res.timings.duration, { endpoint: 'redirect' });
  redirectWaiting.add(res.timings.waiting, { endpoint: 'redirect' });
  redirectConnecting.add(res.timings.connecting, { endpoint: 'redirect' });
  redirectTlsHandshaking.add(res.timings.tls_handshaking, { endpoint: 'redirect' });
}

// --------------------
// Shorten scenario
// --------------------
export function shortenExec() {
  const url = `${TARGET}/shorten`;

  const payload = JSON.stringify({ url: `https://example.com/new/${__VU}/${__ITER}/${Date.now()}` });

  const res = http.post(url, payload, {
    headers: withBypassHeader({ 'Content-Type': 'application/json' }),
    tags: { phase: 'run', endpoint: 'shorten' },
    redirects: 0,
    timeout: '10s',
  });

  const success = check(res, {
    'shorten -> 201': (r) => r.status === 201,
    'shorten content-type is json': (r) => String(r.headers['Content-Type'] || '').includes('application/json'),
  });

  shortenSuccessRate.add(success, { endpoint: 'shorten' });
  shortenStatusCount.add(1, { endpoint: 'shorten', status: String(res.status) });
  shortenDuration.add(res.timings.duration, { endpoint: 'shorten' });
  shortenWaiting.add(res.timings.waiting, { endpoint: 'shorten' });
  shortenConnecting.add(res.timings.connecting, { endpoint: 'shorten' });
  shortenTlsHandshaking.add(res.timings.tls_handshaking, { endpoint: 'shorten' });
}

/*
k6 run \
  -e TARGET="yoururl" \
  -e LOADTEST_BYPASS_KEY="your-bypass-key" \
  -e SEED_FILE="./seed_codes.json" \
  -e MODE=realistic \
  -e BASE_RPS=800 \
  -e SPIKE_MULT=3 \
  -e PRE_VUS=300 \
  -e MAX_VUS=3000 \
  loadtest.js
*/
