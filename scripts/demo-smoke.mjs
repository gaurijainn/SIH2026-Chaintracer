/* global process, performance, console, fetch, Buffer */
// Pre-demo smoke test against a RUNNING stack (default http://localhost:4000, DATA_MODE=replay). Walks the golden case
// through the real API: login -> case view -> trace graph -> CRITICAL alert -> risk -> evidence report (JSON + PDF) ->
// public verification. Read/generate only: it sends no freeze notice. Run `pnpm --filter @ps26183/api demo:seed` first.
//   node scripts/demo-smoke.mjs            (env: BASE_URL, EMAIL, PASSWORD, ACK_NO)
const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const ACK = process.env.ACK_NO ?? 'DEMO-GOLDEN-0001';
const t = async (label, fn) => {
  const t0 = performance.now();
  const out = await fn();
  console.log(`ok  ${label.padEnd(46)} ${(performance.now() - t0).toFixed(0)} ms`);
  return out;
};
const must = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL ${msg}`);
    process.exit(1);
  }
};
const req = async (path, opts = {}, token) => fetch(`${BASE}/api/v1${path}`, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers } });

const login = await t('login (investigator)', async () => (await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: process.env.EMAIL ?? 'investigator@demo.local', password: process.env.PASSWORD ?? 'ChangeMe!123' }) })).json());
must(login.accessToken, 'login failed');
const token = login.accessToken;
const { items } = await (await req(`/complaints?ackNo=${ACK}`, {}, token)).json();
must(items?.[0]?.caseId, `demo case ${ACK} not found; run demo:seed`);
const caseId = items[0].caseId;

const kase = await t('case view (audited)', async () => (await req(`/cases/${caseId}`, {}, token)).json());
must(kase.case?.firNumber?.startsWith('DEMO/FIR'), 'FIR reference not decrypted');
const traceId = kase.case.traces[0].id;
const graph = await t('trace graph', async () => (await req(`/traces/${traceId}/graph`, {}, token)).json());
must(graph.edges.length >= 3, 'graph too small');
const alerts = await t('alerts (CRITICAL)', async () => (await req(`/alerts?caseId=${caseId}&severity=CRITICAL`, {}, token)).json());
must(alerts.alerts.some((a) => a.rule === 'A2_VASP_LANDING'), 'no CRITICAL VASP-landing alert');
const risk = await t('risk (deposit address)', async () => (await req(`/addresses/TRON/${alerts.alerts[0].metadata.landingAddress}/risk`, {}, token)).json());
must(typeof risk.score === 'number', 'no risk score');
const report = await t('evidence report (JSON)', async () => (await req(`/cases/${caseId}/reports?format=json`, { method: 'POST', body: '{}' }, token)).json());
must(report.report?.sha256, 'no report hash');
await t('evidence report (PDF)', async () => {
  const r = await req(`/cases/${caseId}/reports?format=pdf`, { method: 'POST', body: '{}' }, token);
  const buf = Buffer.from(await r.arrayBuffer());
  must(r.status === 201 && buf.subarray(0, 4).toString() === '%PDF', `PDF export failed (${r.status})`);
});
const verify = await t('verify hash (public, no token)', async () => (await req(`/verify/${report.report.sha256}`)).json());
must(verify.match === true, 'hash did not verify');
console.log(`\nGOLDEN DEMO OK: case ${caseId} | ${graph.edges.length} hops | alert ${alerts.alerts[0].rule}/${alerts.alerts[0].severity} | risk ${risk.score} ${risk.band} | sha256 ${report.report.sha256.slice(0, 16)}… verified`);
