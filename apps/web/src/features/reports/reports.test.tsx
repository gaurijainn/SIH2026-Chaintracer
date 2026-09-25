import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { json, mountApp, resetAppState, signInAs, type FetchHandler } from '@/test/utils';
import type { Role } from '@/stores/auth';

// Controlled test fixtures standing in for the backend's responses; the UI under test only renders what it is sent.
const HASH = 'a'.repeat(64);
const JSON_HASH = 'b'.repeat(64);
const COMPLAINTS = { total: 1, page: 1, pageSize: 200, items: [{ id: 'c1', ackNo: 'ACK-1', reportedAt: '2026-09-20T07:00:00.000Z', category: 'X', amountInr: '1000', network: 'TRON', caseId: 'case-1', case: { id: 'case-1', title: 'NCRP ACK-1', status: 'OPEN' }, addresses: [{ address: 'TSEED', chain: 'TRON', kind: 'ADDRESS' }] }] };
const CASE = { id: 'case-1', title: 'NCRP ACK-1', status: 'OPEN', firNumber: 'FIR-77/2026', complaints: [{ id: 'c1', ackNo: 'ACK-1' }], traces: [] };
const VASPS = [{ id: 'v1', name: 'Demo Exchange', type: 'CENTRALISED_EXCHANGE', jurisdiction: 'Seychelles', fiuStatus: 'NOTICED', addresses: [] }];
const ALERTS = [{ id: 'al1', caseId: 'case-1', rule: 'A2_VASP_LANDING', severity: 'HIGH', status: 'NEW', chain: 'TRON', address: 'TVASP', amount: null, message: 'Funds landed', metadata: null, createdAt: '2026-09-21T00:00:00.000Z' }];
const EVIDENCE = { schemaVersion: 'evidence.v1', generatedAt: '2026-09-25T00:00:00.000Z', case: { id: 'case-1', title: 'NCRP ACK-1', status: 'OPEN', firNumber: 'FIR-77/2026', ackNo: 'ACK-1' }, hops: [{ hopNo: 1 }, { hopNo: 2 }], attribution: [], risk: [], sources: [{ provider: 'tronscan', retrievedAt: 'x' }], limitations: ['Amounts in INR are not available.'] };
const JSON_BODY = JSON.stringify({ report: { id: 'r2', caseId: 'case-1', version: 'evidence.v1', sha256: JSON_HASH, pdfPath: null, createdAt: '2026-09-25T00:00:00.000Z' }, evidence: EVIDENCE, integrity: { firNumberAsHashed: 'FIR-77/2026' } });

type Notice = { id: string; status: string; legalProvision: string | null; submissionId: string | null; approvedById: string | null; approvedAt: string | null; sentAt: string | null; [k: string]: unknown };
const notice = (over: Partial<Notice> = {}): Notice => ({
  id: 'n1', caseId: 'case-1', vaspId: 'v1', status: 'DRAFT', legalProvision: null, legalCellReviewed: false,
  body: { vasp: { id: 'v1', name: 'Demo Exchange', jurisdiction: 'Seychelles', contactEmail: 'freeze@demo.example', contactPortal: null }, depositAddresses: ['TVASP'], txHashes: ['0xhash1'], amounts: [{ chain: 'TRON', token: 'USDT', amount: '500', usd: '500' }], alertId: null, requestedAt: { utc: '2026-09-25T08:30:00.000Z', ist: { iso: '2026-09-25T08:30:00.000Z', display: '25 Sept 2026, 14:00:00 IST' } }, requests: { freeze: 'Request to freeze the identified deposit address(es).' } },
  submissionId: null, approvedById: null, approvedAt: null, sentAt: null, createdAt: '2026-09-25T00:00:00.000Z', ...over,
});

function open(role: Role = 'SUPERVISOR', extra: FetchHandler = () => undefined, path = '/reports?caseId=case-1') {
  signInAs(role);
  const { fetchMock } = mountApp(path, (url, init) => {
    const custom = extra(url, init);
    if (custom) return custom;
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/complaints') return json(200, COMPLAINTS);
    if (p === '/alerts') return json(200, { alerts: ALERTS });
    if (p === '/vasps') return json(200, { vasps: VASPS });
    if (p === '/cases/case-1') return json(200, { case: CASE });
    return undefined;
  });
  return fetchMock;
}
const calls = (fm: { mock: { calls: unknown[][] } }) => fm.mock.calls.map(([u, i]) => ({ url: new URL(String(u), 'http://x'), method: ((i as RequestInit | undefined)?.method ?? 'GET').toUpperCase(), body: (i as RequestInit | undefined)?.body }));
const posts = (fm: { mock: { calls: unknown[][] } }) => calls(fm).filter((c) => c.method !== 'GET' && !c.url.pathname.includes('/auth/'));

const pdfResponse = () => new Response('%PDF-1.4 fake', { status: 201, headers: { 'Content-Type': 'application/pdf', 'X-Report-Id': 'r1', 'X-Report-Sha256': HASH } });

/** A tiny stateful stand-in for the notice endpoints; it applies the same transitions the backend documents. */
function noticeBackend(state: { n: Notice }, calls: string[] = []): FetchHandler {
  return (url, init) => {
    const p = url.pathname.replace('/api/v1', '');
    const m = (init.method ?? 'GET').toUpperCase();
    if (m === 'POST' && p === '/cases/case-1/freeze-notices') { calls.push('draft'); return json(201, { freezeNotice: state.n }); }
    if (m === 'PATCH' && p === '/freeze-notices/n1') { calls.push('edit'); state.n = { ...state.n, legalProvision: JSON.parse(String(init.body)).legalProvision }; return json(200, { freezeNotice: state.n }); }
    if (m === 'POST' && p === '/freeze-notices/n1/submit') { calls.push('submit'); state.n = { ...state.n, status: 'PENDING_APPROVAL' }; return json(200, { freezeNotice: state.n }); }
    if (m === 'POST' && p === '/freeze-notices/n1/approve') { calls.push('approve'); state.n = { ...state.n, status: 'APPROVED', approvedAt: '2026-09-25T01:00:00.000Z', approvedById: 'u-sup' }; return json(200, { freezeNotice: state.n }); }
    if (m === 'POST' && p === '/freeze-notices/n1/send') { calls.push('send'); state.n = { ...state.n, status: 'SENT', submissionId: 'SAHYOG-SUB-9', sentAt: '2026-09-25T02:00:00.000Z' }; return json(200, { freezeNotice: state.n }); }
    return undefined;
  };
}

async function draftNotice() {
  const user = userEvent.setup();
  await screen.findByRole('option', { name: /Demo Exchange/ });
  await user.selectOptions(screen.getByLabelText('VASP'), 'v1');
  await user.click(screen.getByRole('button', { name: 'Draft freeze notice' }));
  await screen.findByRole('heading', { name: 'Freeze notice to Demo Exchange' });
  return user;
}

describe('F8 report builder', () => {
  beforeEach(() => {
    resetAppState();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }));
  });

  it('renders on the existing /reports route with real cases and read-only FIR / NCRP values from the case', async () => {
    const fm = open();
    expect(await screen.findByRole('heading', { name: 'Reports' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /NCRP ACK-1 · OPEN/ })).toBeInTheDocument();
    expect(await screen.findByText('FIR-77/2026')).toBeInTheDocument();
    expect(screen.getByText('ACK-1')).toBeInTheDocument();
    expect(screen.getByText(/no fields for IO name, rank or police station/)).toBeInTheDocument();
    expect(calls(fm).some((c) => c.url.pathname === '/api/v1/complaints')).toBe(true);
    expect(posts(fm)).toHaveLength(0);
  });

  it('generates the PDF via POST ?format=pdf, previews the returned bytes, shows the server hash and downloads those bytes', async () => {
    const fm = open('SUPERVISOR', (url) => (url.pathname.endsWith('/cases/case-1/reports') ? pdfResponse() : undefined));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Generate PDF/ }));
    expect(await screen.findByTitle('PDF report preview')).toHaveAttribute('src', 'blob:preview');
    expect(screen.getByTestId('sha256')).toHaveTextContent(HASH);
    const pdfCalls = posts(fm).filter((c) => c.url.pathname === '/api/v1/cases/case-1/reports');
    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]!.url.searchParams.get('format')).toBe('pdf');
    expect(screen.getByText(/Generated in \d+ ms/)).toBeInTheDocument();

    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
    await user.click(screen.getByRole('button', { name: /Download PDF/ }));
    expect(clicked[0]!.download).toBe('evidence-r1.pdf');
    const blobs = vi.mocked(URL.createObjectURL).mock.calls.map(([b]) => b as Blob);
    expect(blobs.length).toBeGreaterThanOrEqual(2);
    for (const b of blobs) expect(await b.text()).toBe('%PDF-1.4 fake');
  });

  it('generates JSON via POST ?format=json and downloads the exact text the server sent', async () => {
    const fm = open('SUPERVISOR', (url) => (url.pathname.endsWith('/cases/case-1/reports') ? new Response(JSON_BODY, { status: 201, headers: { 'Content-Type': 'application/json' } }) : undefined));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Generate JSON/ }));
    expect(await screen.findByText('2 hops')).toBeInTheDocument();
    expect(screen.getByText('Amounts in INR are not available.')).toBeInTheDocument();
    expect(screen.getByTestId('sha256')).toHaveTextContent(JSON_HASH);
    expect(posts(fm)[0]!.url.searchParams.get('format')).toBe('json');

    const created: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((b) => { created.push(b as Blob); return 'blob:x'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await user.click(screen.getByRole('button', { name: /Download JSON/ }));
    expect(created).toHaveLength(1);
    expect(await created[0]!.text()).toBe(JSON_BODY);
  });

  it('Verify calls GET /verify/:hash and reports a match only after the server answers', async () => {
    const fm = open('SUPERVISOR', (url) => {
      if (url.pathname.endsWith('/cases/case-1/reports')) return pdfResponse();
      if (url.pathname === `/api/v1/verify/${HASH}`) return json(200, { match: true, report: { id: 'r1', caseId: 'case-1', version: 'evidence.v1', sha256: HASH, createdAt: '2026-09-25T00:00:00.000Z' } });
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Generate PDF/ }));
    await screen.findByTestId('sha256');
    expect(screen.queryByText(/Verified/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Verify/ }));
    expect(await screen.findByText(/Verified: stored evidence matches/)).toBeInTheDocument();
    expect(calls(fm).some((c) => c.url.pathname === `/api/v1/verify/${HASH}` && c.method === 'GET')).toBe(true);
  });

  it('shows a mismatch and a verification failure', async () => {
    let answer: 'mismatch' | 'missing' = 'mismatch';
    open('SUPERVISOR', (url) => {
      if (url.pathname.endsWith('/cases/case-1/reports')) return pdfResponse();
      if (url.pathname.startsWith('/api/v1/verify/')) return answer === 'mismatch' ? json(200, { match: false, report: null }) : json(404, { error: 'EVIDENCE_NOT_FOUND' });
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Generate PDF/ }));
    await user.click(await screen.findByRole('button', { name: /Verify/ }));
    expect(await screen.findByText(/Mismatch: stored evidence does not match/)).toBeInTheDocument();
    answer = 'missing';
    await user.click(screen.getByRole('button', { name: /Verify/ }));
    expect(await screen.findByText(/Verification failed/)).toBeInTheDocument();
  });

  it('shows the operation failure when report generation fails, and no report', async () => {
    open('SUPERVISOR', (url) => (url.pathname.endsWith('/cases/case-1/reports') ? json(500, { error: 'REPORT_GENERATION_FAILED' }) : undefined));
    await userEvent.setup().click(await screen.findByRole('button', { name: /Generate PDF/ }));
    expect(await screen.findByText(/PDF generation failed/)).toBeInTheDocument();
    expect(screen.queryByTestId('sha256')).not.toBeInTheDocument();
  });
});

describe('F8 freeze notice workflow', () => {
  beforeEach(() => resetAppState());

  it('drafts with the real VASP id and optional alert id only, then shows the backend-built body', async () => {
    const state = { n: notice() };
    const fm = open('SUPERVISOR', noticeBackend(state));
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Demo Exchange/ });
    await user.selectOptions(screen.getByLabelText('VASP'), 'v1');
    await screen.findByRole('option', { name: /Funds landed/ });
    await user.selectOptions(screen.getByLabelText('Alert (optional)'), 'al1');
    await user.click(screen.getByRole('button', { name: 'Draft freeze notice' }));
    expect(await screen.findByText('freeze@demo.example')).toBeInTheDocument();
    expect(screen.getByText('0xhash1')).toBeInTheDocument();
    expect(screen.getByText(/25 Sep[a-z]* 2026, 14:00 IST/)).toBeInTheDocument();
    const [draft] = posts(fm);
    expect(draft!.url.pathname).toBe('/api/v1/cases/case-1/freeze-notices');
    expect(JSON.parse(String(draft!.body))).toEqual({ vaspId: 'v1', alertId: 'al1' });
    expect(screen.getByLabelText('Legal provision')).toHaveValue('');
  });

  it('shows an honest empty state before any notice exists', async () => {
    open();
    expect(await screen.findByText('No freeze notice in this session')).toBeInTheDocument();
  });

  it('walks Draft → Pending approval → Approved → Sent through the real endpoints, without a second SAHYOG call', async () => {
    const seen: string[] = [];
    const fm = open('SUPERVISOR', noticeBackend({ n: notice() }, seen));
    const user = await draftNotice();
    const send = screen.getByRole('button', { name: /Submit to SAHYOG/ });
    expect(send).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();

    await user.type(screen.getByLabelText('Legal provision'), 'Officer-entered text');
    await user.click(screen.getByRole('button', { name: 'Save legal provision' }));
    await waitFor(() => expect(seen).toContain('edit'));
    const edit = posts(fm).find((c) => c.method === 'PATCH')!;
    expect(JSON.parse(String(edit.body))).toEqual({ legalProvision: 'Officer-entered text' });

    await user.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
    expect(screen.getByLabelText('Legal provision')).toBeEnabled();
    expect(send).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Submit to SAHYOG/ })).toBeEnabled());
    expect(screen.getByLabelText('Legal provision')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Submit to SAHYOG/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Submit' }));
    expect(await screen.findByText('SAHYOG-SUB-9')).toBeInTheDocument();
    expect(screen.getByText(/Submitted to the SAHYOG sandbox/)).toBeInTheDocument();

    expect(seen).toEqual(['draft', 'edit', 'submit', 'approve', 'send']);
    expect(calls(fm).some((c) => c.url.pathname.includes('/integrations/'))).toBe(false);
  });

  it('an Investigator can draft and submit but cannot approve or send', async () => {
    const seen: string[] = [];
    open('INVESTIGATOR', noticeBackend({ n: notice() }, seen));
    const user = await draftNotice();
    await user.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(seen).toContain('submit'));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Submit to SAHYOG/ })).toBeDisabled();
    expect(screen.getByText(/require the Supervisor role/)).toBeInTheDocument();
  });

  it('a Viewer cannot open the builder at all', async () => {
    const fm = open('VIEWER');
    expect(await screen.findByText('Not available for your role')).toBeInTheDocument();
    expect(posts(fm)).toHaveLength(0);
  });

  it('shows the backend explanation for an invalid transition and the real permission error for a 403', async () => {
    const state = { n: notice({ status: 'PENDING_APPROVAL' }) };
    let mode: 'invalid' | 'forbidden' = 'invalid';
    open('SUPERVISOR', (url, init) => {
      const p = url.pathname.replace('/api/v1', '');
      if (p === '/freeze-notices/n1/approve') return mode === 'invalid' ? json(400, { error: 'INVALID_TRANSITION', message: 'freeze notice n1 must be PENDING_APPROVAL to approve (currently APPROVED)' }) : json(403, { error: 'FORBIDDEN' });
      return noticeBackend(state)(url, init);
    });
    const user = await draftNotice();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/must be PENDING_APPROVAL to approve \(currently APPROVED\)/)).toBeInTheDocument();
    expect(screen.getByText('Pending approval', { selector: 'span' })).toBeInTheDocument();
    mode = 'forbidden';
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Your role does not permit this action.')).toBeInTheDocument();
  });

  it('a failed SAHYOG submission leaves the notice Approved and shows the failure', async () => {
    const state = { n: notice({ status: 'APPROVED' }) };
    open('SUPERVISOR', (url, init) => (url.pathname === '/api/v1/freeze-notices/n1/send' ? json(500, { error: 'INTERNAL' }) : noticeBackend(state)(url, init)));
    const user = await draftNotice();
    await user.click(screen.getByRole('button', { name: /Submit to SAHYOG/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Submit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/server hit a problem/);
    expect(screen.queryByText(/Submitted to the SAHYOG sandbox/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit to SAHYOG/ })).toBeEnabled();
  });

  it('only renders fields the backend returned (no invented contact, amounts or attribution)', async () => {
    const bare = notice({ body: { vasp: { id: 'v1', name: 'Demo Exchange' } } });
    open('SUPERVISOR', noticeBackend({ n: bare }));
    await draftNotice();
    expect(screen.getByText('None on file')).toBeInTheDocument();
    expect(screen.getByText('None found')).toBeInTheDocument();
    expect(screen.queryByText('Amounts')).not.toBeInTheDocument();
    expect(screen.queryByText(/INR|confidence|sanction/i)).not.toBeInTheDocument();
  });

  it('F6 deep link preselects the VASP', async () => {
    open('SUPERVISOR', () => undefined, '/reports?caseId=case-1&vaspId=v1');
    const select = (await screen.findByLabelText('VASP')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('v1'));
    fireEvent.change(select, { target: { value: 'v1' } });
  });
});
