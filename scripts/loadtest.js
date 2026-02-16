import http from 'k6/http';
import { check } from 'k6';

export let options = {
  scenarios: {
    high_load: {
      executor: 'constant-arrival-rate',
      rate: 800,            // Attempt 300 requests per second (RPS)
      timeUnit: '1s',
      duration: '5s',
      preAllocatedVUs: 300, // Pre-allocate required virtual users
      maxVUs: 1000,         // Maximum virtual users allowed
    },
  },

  thresholds: {
    http_req_duration: ['p(95)<300'], // Target p95 < 300ms
  },
};

export default function () {
  const url = 'http://host.docker.internal:8080/shorten';

  const payload = JSON.stringify({
    url: `https://example.com/test-${Math.random().toString(36).slice(2)}`
  });

  const params = {
    headers: { 'Content-Type': 'application/json' },
  };

  let res = http.post(url, payload, params);

  check(res, {
    'status is 201': (r) => r.status === 201,
  });
}

export function handleSummary(data) {
  const m = data.metrics;
  return {
    stdout: `
RPS        : ${m.http_reqs.values.rate}
Avg (ms)   : ${m.http_req_duration.values.avg}
p95 (ms)   : ${m.http_req_duration.values["p(95)"]}
Errors (%) : ${m.http_req_failed.values.rate * 100}
  `,
  };
}
