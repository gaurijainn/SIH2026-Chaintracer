/* global __ENV */
// B11 load test for the two read endpoints the plan names: trace graph and address risk.
// Runs against a local stack in DATA_MODE=replay (no external providers are called). Seed the demo cases first:
//   pnpm --filter @ps26183/api demo:seed
// Then (k6 via Docker, no local install needed; raise the API rate limit for the run):
//   RATE_LIMIT_MAX=1000000 docker compose up -d api
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:4000 -v "$PWD/scripts/k6:/scripts" grafana/k6 run /scripts/graph-risk.k6.js
// Tunables: VUS (default 10), DURATION (default 30s), EMAIL / PASSWORD (demo viewer by default), ACK_NO (golden case).
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:4000';
const ACK_NO = __ENV.ACK_NO || 'DEMO-GOLDEN-0001';
const DEPOSIT = __ENV.RISK_ADDR || 'THdbKZ9khHToEXDzLjudNhYJHmWb4fg3Ni'; // golden case's exchange deposit address
const errors5xx = new Counter('server_errors_5xx');

export const options = {
  scenarios: {
    graph: { executor: 'constant-vus', vus: Number(__ENV.VUS || 10), duration: __ENV.DURATION || '30s', exec: 'graph', tags: { endpoint: 'graph' } },
    risk: { executor: 'constant-vus', vus: Number(__ENV.VUS || 10), duration: __ENV.DURATION || '30s', exec: 'risk', tags: { endpoint: 'risk' } },
  },
  // No pass/fail latency targets: the plan sets none, so this run only reports what was measured.
  // Empty threshold lists exist only to make k6 print per-endpoint sub-metrics; nothing can fail on latency.
  thresholds: {
    'http_req_duration{endpoint:graph}': [],
    'http_req_duration{endpoint:risk}': [],
    'http_req_failed{endpoint:graph}': [],
    'http_req_failed{endpoint:risk}': [],
    'http_reqs{endpoint:graph}': [],
    'http_reqs{endpoint:risk}': [],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const login = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email: __ENV.EMAIL || 'viewer@demo.local', password: __ENV.PASSWORD || 'ChangeMe!123' }), { headers: { 'Content-Type': 'application/json' } });
  if (login.status !== 200) fail(`login failed (${login.status}): ${login.body}`);
  const auth = { Authorization: `Bearer ${login.json('accessToken')}` };
  const complaints = http.get(`${BASE}/api/v1/complaints?ackNo=${encodeURIComponent(ACK_NO)}`, { headers: auth });
  const caseId = complaints.json('items.0.caseId') || complaints.json('complaints.0.caseId');
  if (!caseId) fail(`demo case ${ACK_NO} not found; run demo:seed. Response: ${complaints.body}`);
  const kase = http.get(`${BASE}/api/v1/cases/${caseId}`, { headers: auth });
  const traceId = kase.json('case.traces.0.id');
  if (!traceId) fail(`case ${caseId} has no trace`);
  return { token: login.json('accessToken'), traceId };
}

const headers = (d) => ({ headers: { Authorization: `Bearer ${d.token}` } });

export function graph(d) {
  const r = http.get(`${BASE}/api/v1/traces/${d.traceId}/graph`, headers(d));
  if (r.status >= 500) errors5xx.add(1);
  check(r, { 'graph 200': (x) => x.status === 200, 'graph has edges': (x) => x.status === 200 && x.json('edges').length > 0 });
}

export function risk(d) {
  const r = http.get(`${BASE}/api/v1/addresses/TRON/${DEPOSIT}/risk`, headers(d));
  if (r.status >= 500) errors5xx.add(1);
  check(r, { 'risk 200': (x) => x.status === 200, 'risk has score': (x) => x.status === 200 && typeof x.json('score') === 'number' });
}
