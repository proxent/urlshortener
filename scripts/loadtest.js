import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

// --------------------
// Env (tweak here)
// --------------------
const TARGET = (__ENV.TARGET || 'http://localhost:3000').replace(/\/$/, '');

// Total target RPS (redirect + shorten combined)
const BASE_RPS = parseInt(__ENV.BASE_RPS || '500', 10);
const SPIKE_MULT = parseFloat(__ENV.SPIKE_MULT || '3');

// Traffic mix
const REDIRECT_RATIO = parseFloat(__ENV.REDIRECT_RATIO || '0.98'); // 98%
const SHORTEN_RATIO = 1 - REDIRECT_RATIO;

// Seed dataset size (existing codes created in setup)
const SEED_N = parseInt(__ENV.SEED_N || '20000', 10);

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

// Prevent following redirects (measure only the 302 response)
export const options = (() => {
  const baseStages = [
    { target: BASE_RPS, duration: '5m' },                          // warm-up ramp
    { target: BASE_RPS, duration: '15m' },                         // steady
    { target: Math.floor(BASE_RPS * SPIKE_MULT), duration: '2m' }, // spike
    { target: BASE_RPS, duration: '5m' },                          // recovery
  ];

  // For cold/warm comparisons, you may want a longer steady run without spikes
  const steadyOnly = [
    { target: BASE_RPS, duration: '3m' },
    { target: BASE_RPS, duration: '12m' },
  ];

  const stages = (MODE === 'cold' || MODE === 'warm') ? steadyOnly : baseStages;

  return {
    maxRedirects: 0,
    discardResponseBodies: true,
    thresholds: {
      // Overall failure rate (redirect + shorten) — only for the run phase
      'http_req_failed{phase:run}': ['rate<0.01'],

      // Redirect SLO (tune numbers as you like)
      'http_req_duration{phase:run,endpoint:redirect}': ['p(95)<100', 'p(99)<250'],

      // Shorten SLO
      'http_req_duration{phase:run,endpoint:shorten}': ['p(95)<300', 'p(99)<800'],

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

function genUrl(i) {
  // Must pass isValidUrl (the URL does not need to be reachable)
  return `https://example.com/${MODE}/${i}`;
}

// --------------------
// Setup: seed codes
// --------------------
export function setup() {
  const created = [];

  const url = `${TARGET}/shorten`;
  const params = {
    headers: { 'Content-Type': 'application/json' },
    tags: { phase: 'setup', endpoint: 'shorten' },
    redirects: 0,
    timeout: '30s',
  };

  // If SEED_N is too large, setup will take longer and the DB will grow.
  // For cache ON/OFF comparisons, keep SEED_N fixed across runs.
  for (let i = 0; i < SEED_N; i++) {
    const payload = JSON.stringify({ url: genUrl(i) });
    const res = http.post(url, payload, params);

    const ok = check(res, {
      'setup shorten -> 201': (r) => r.status === 201,
      'setup shorten has code': (r) => !!r.json('code'),
    });

    if (!ok) {
      // Stop early so you can inspect the failure
      throw new Error(`Setup failed at i=${i}, status=${res.status}, body=${res.body}`);
    }

    created.push(res.json('code'));
  }

  // hot/cold split
  const hotCount = Math.max(1, Math.floor(created.length * HOT_SET_PCT));
  const hotCodes = created.slice(0, hotCount);
  const coldCodes = created.slice(hotCount);

  return { codes: created, hotCodes, coldCodes };
}

// --------------------
// Redirect scenario
// --------------------
export function redirectExec(data) {
  const codes = data.codes;
  const hotCodes = data.hotCodes;
  const coldCodes = data.coldCodes;

  const code = pickCodeSkewed(codes, hotCodes, coldCodes);
  const url = `${TARGET}/r/${code}`;

  const res = http.get(url, {
    tags: { phase: 'run', endpoint: 'redirect' },
    redirects: 0,   // Measure only the 302 response
    timeout: '10s',
  });

  check(res, {
    'redirect -> 302': (r) => r.status === 302,
    'redirect has Location': (r) => !!r.headers.Location,
  });

  // With arrival-rate executors, sleep is optional (you can keep it at 0)
}

// --------------------
// Shorten scenario
// --------------------
export function shortenExec() {
  const url = `${TARGET}/shorten`;

  const payload = JSON.stringify({ url: `https://example.com/new/${__VU}/${__ITER}/${Date.now()}` });

  const res = http.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { phase: 'run', endpoint: 'shorten' },
    redirects: 0,
    timeout: '10s',
  });

  check(res, {
    'shorten -> 201': (r) => r.status === 201,
    'shorten has code': (r) => !!r.json('code'),
  });
}
