import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { json, mountApp, resetAppState, signInAs, type FetchHandler } from '@/test/utils';
import { useAuthStore } from '@/stores/auth';
import type { Role } from '@/stores/auth';
import { BTC_A, csvFile, ETH_A, HEADER, TRON_A, TRON_B } from './testData';

beforeEach(resetAppState);

const summary = { total: 1, created: 1, duplicates: 0, invalid: 0, linked: 0, casesCreated: 1, traceJobsPrepared: 1, tronTraceJobs: 1, queued: 1, timings: { validationMs: 1, persistMs: 1, totalMs: 2 } };
const created = { row: 1, ackNo: 'ACK-100', status: 'CREATED', errors: [], warnings: [], complaintId: 'c1', caseId: 'case-1234-abcd', caseCreated: true, traceJobs: [{ id: 't1', chain: 'TRON', seed: TRON_A, queue: 'trace-tron', reused: false }] };

const stat = (root: HTMLElement, label: string) => within(root).getAllByText(label).map((e) => e.closest('div.rounded-lg')).find((e): e is HTMLElement => !!e)!;
const posts = (fn: ReturnType<typeof mountApp>['fetchMock'], path: string) => fn.mock.calls.filter(([u, i]) => String(u).endsWith(path) && (i as RequestInit)?.method === 'POST');

async function fillSingle(over: Partial<Record<'ack' | 'amt' | 'cat' | 'addr', string>> = {}) {
  await userEvent.type(screen.getByLabelText(/NCRP acknowledgement number/), over.ack ?? 'ACK-100');
  fireEvent.change(screen.getByLabelText(/Complaint date and time/), { target: { value: '2026-09-01T08:30' } });
  await userEvent.type(screen.getByLabelText(/Amount lost/), over.amt ?? '250000');
  await userEvent.type(screen.getByLabelText(/^Category/), over.cat ?? 'Investment fraud');
  await userEvent.type(screen.getByLabelText(/Suspect wallet address/), over.addr ?? TRON_A);
}

describe('permissions', () => {
  it.each(['INVESTIGATOR', 'SUPERVISOR'] as Role[])('%s can open intake and sees every intake method', (role) => {
    signInAs(role);
    mountApp('/intake');
    expect(screen.getByRole('heading', { name: 'Complaint intake' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register complaint' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Single complaint', 'Bulk CSV import', 'Paste addresses']);
  });

  it.each(['VIEWER', 'ADMIN'] as Role[])('%s reaching /intake directly gets the permission-denied page, not the form', (role) => {
    signInAs(role);
    const { fetchMock } = mountApp('/intake');
    expect(screen.getByText('Not available for your role')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register complaint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(posts(fetchMock, '/complaints')).toHaveLength(0);
  });
});

describe('single complaint', () => {
  it('marks required fields and blocks submission with inline, accessible errors', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/intake');
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    expect(await screen.findByText('Enter the NCRP acknowledgement number')).toBeInTheDocument();
    expect(screen.getByText('Enter the complaint date')).toBeInTheDocument();
    expect(screen.getByText('Enter the amount in INR')).toBeInTheDocument();
    expect(screen.getByText('Enter the complaint category')).toBeInTheDocument();
    expect(screen.getByText('Enter the suspect wallet address')).toBeInTheDocument();
    const ack = screen.getByLabelText(/NCRP acknowledgement number/);
    expect(ack).toHaveAttribute('aria-invalid', 'true');
    expect(ack).toHaveAttribute('aria-describedby', 'ackNo-error');
    expect(posts(fetchMock, '/complaints')).toHaveLength(0);
  });

  it('rejects a malformed address and an invalid amount without calling the API', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/intake');
    await fillSingle({ amt: '-5', addr: 'TXnotvalid' });
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    expect(await screen.findByText(/Enter a positive amount/)).toBeInTheDocument();
    expect(screen.getByText(/TXnotvalid: TRON address must be 34 characters/)).toBeInTheDocument();
    expect(posts(fetchMock, '/complaints')).toHaveLength(0);
  });

  it('submits to POST /api/v1/complaints with the contract payload, shows the loading state, then the real result', async () => {
    signInAs('INVESTIGATOR');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler: FetchHandler = async (url, init) => {
      if (url.pathname === '/api/v1/complaints' && init.method === 'POST') {
        await gate;
        return json(201, { complaint: created, summary });
      }
    };
    const { fetchMock } = mountApp('/intake', handler);
    await fillSingle();
    expect(await screen.findByTestId('detected-chain')).toHaveTextContent('Fast path');
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    const busy = await screen.findByRole('button', { name: /Submitting/ });
    expect(busy).toBeDisabled();
    release();
    expect(await screen.findByText('Complaint registered')).toBeInTheDocument();

    const [url, init] = posts(fetchMock, '/complaints')[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/complaints');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1');
    expect(JSON.parse(init.body as string)).toEqual({ ackNo: 'ACK-100', reportedAt: '2026-09-01T08:30', category: 'Investment fraud', amountInr: '250000', addresses: [TRON_A] });
    const result = screen.getByRole('heading', { name: 'Result' }).closest('section')!;
    expect(within(result).getByText('trace-tron')).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: /Open case case-1234-abcd/ })).toHaveAttribute('href', '/cases/case-1234-abcd');
    expect(screen.getByLabelText(/NCRP acknowledgement number/)).toHaveValue('');
  });

  it('sends the chosen network', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/intake', (u, i) => (u.pathname.endsWith('/complaints') && i.method === 'POST' ? json(201, { complaint: created, summary }) : undefined));
    await fillSingle({ addr: ETH_A });
    await userEvent.selectOptions(screen.getByLabelText(/^Network/), 'ERC20');
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    await screen.findByText('Complaint registered');
    expect(JSON.parse((posts(fetchMock, '/complaints')[0][1] as RequestInit).body as string)).toMatchObject({ network: 'ERC20', addresses: [ETH_A] });
  });

  it('maps a 422 from the API onto the offending field', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake', (u, i) =>
      u.pathname.endsWith('/complaints') && i.method === 'POST'
        ? json(422, { complaint: { row: 1, ackNo: 'ACK-100', status: 'INVALID', warnings: [], errors: [{ field: 'addresses[0]', code: 'INVALID_ADDRESS', message: `${TRON_A}: Base58Check checksum failed (likely a typo)` }] }, summary })
        : undefined,
    );
    await fillSingle();
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    expect(await screen.findByText(/Base58Check checksum failed/)).toBeInTheDocument();
    expect(screen.getByText('The complaint was not accepted. Review the highlighted problems and try again.')).toBeInTheDocument();
    expect(screen.queryByText('Complaint registered')).not.toBeInTheDocument();
  });

  it('shows a friendly message for a 500 and never the raw server text', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake', (u, i) => (u.pathname.endsWith('/complaints') && i.method === 'POST' ? json(500, { error: 'INTERNAL', message: 'SECRET stack trace at db.ts:42' }) : undefined));
    await fillSingle();
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    expect(await screen.findByText(/The server hit a problem processing this request/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
  });

  it('reports an already-registered complaint as a duplicate, not as created', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake', (u, i) =>
      u.pathname.endsWith('/complaints') && i.method === 'POST' ? json(200, { complaint: { row: 1, ackNo: 'ACK-100', status: 'DUPLICATE', duplicateOf: 'existing', complaintId: 'c0', caseId: 'case-old-0001', errors: [], warnings: [] }, summary: { ...summary, created: 0, duplicates: 1 } }) : undefined,
    );
    await fillSingle();
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    expect(await screen.findByText('Already registered')).toBeInTheDocument();
    expect(screen.queryByText('Complaint registered')).not.toBeInTheDocument();
  });

  it('refreshes an expired token through the shared client and retries the submission', async () => {
    signInAs('INVESTIGATOR');
    let first = true;
    const { fetchMock } = mountApp('/intake', (u, i) => {
      if (u.pathname === '/api/v1/auth/refresh') return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2' });
      if (u.pathname.endsWith('/complaints') && i.method === 'POST') {
        if (first) {
          first = false;
          return json(401, { error: 'TOKEN_EXPIRED' });
        }
        return json(201, { complaint: created, summary });
      }
    });
    await fillSingle();
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint' }));
    await screen.findByText('Complaint registered');
    expect(posts(fetchMock, '/complaints')).toHaveLength(2);
    expect(useAuthStore.getState().accessToken).toBe('access-2');
  });
});

describe('TRON fast path', () => {
  it('is visible on the page and when TRC20 is selected', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake');
    expect(screen.getByText('TRON fast path enabled')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/^Network/), 'TRC20');
    expect(screen.getAllByRole('note').some((n) => /dedicated TRON trace queue/.test(n.textContent ?? ''))).toBe(true);
  });
});

describe('paste addresses', () => {
  const paste = async (text: string) => {
    await userEvent.click(screen.getByRole('tab', { name: 'Paste addresses' }));
    await userEvent.click(screen.getByLabelText(/Suspect wallet addresses/));
    await userEvent.paste(text);
  };

  it('shows valid/invalid/duplicate counts, chain badges and TRON fast path per line', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake');
    await paste(`  ${TRON_A} \n\n${BTC_A}\n${TRON_A}\nnot-an-address`);
    const preview = await screen.findByTestId('paste-preview');
    expect(within(preview).getByRole('status')).toHaveTextContent('4 entries2 valid1 invalid1 duplicate');
    expect(within(preview).getByText('TRON')).toBeInTheDocument();
    expect(within(preview).getByText('BTC')).toBeInTheDocument();
    expect(within(preview).getByText('Fast path')).toBeInTheDocument();
    expect(within(preview).getByText(/same as line 1; sent once/)).toBeInTheDocument();
    expect(within(preview).getByText(/not a recognised TRON, EVM or Bitcoin address/)).toBeInTheDocument();
  });

  it('asks for a chain instead of guessing for EVM addresses, and does not submit while entries are invalid', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/intake');
    await paste(`${ETH_A}\nbad`);
    expect(await screen.findByText(/the chain cannot be safely inferred/)).toBeInTheDocument();
    expect(screen.getByText('Select chain')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Register complaint with/ }));
    expect(posts(fetchMock, '/complaints')).toHaveLength(0);
  });

  it('registers all valid pasted addresses on one complaint via POST /complaints', async () => {
    signInAs('INVESTIGATOR');
    const { fetchMock } = mountApp('/intake', (u, i) => (u.pathname.endsWith('/complaints') && i.method === 'POST' ? json(201, { complaint: created, summary }) : undefined));
    await userEvent.click(screen.getByRole('tab', { name: 'Paste addresses' }));
    await userEvent.type(screen.getByLabelText(/NCRP acknowledgement number/), 'ACK-200');
    fireEvent.change(screen.getByLabelText(/Complaint date and time/), { target: { value: '2026-09-01T08:30' } });
    await userEvent.type(screen.getByLabelText(/Amount lost/), '1000');
    await userEvent.type(screen.getByLabelText(/^Category/), 'Phishing');
    await userEvent.click(screen.getByLabelText(/Suspect wallet addresses/));
    await userEvent.paste(`${TRON_A}\n${TRON_B}\n${TRON_A}`);
    await userEvent.click(screen.getByRole('button', { name: 'Register complaint with 2 addresses' }));
    await screen.findByText('Complaint registered');
    expect(JSON.parse((posts(fetchMock, '/complaints')[0][1] as RequestInit).body as string).addresses).toEqual([TRON_A, TRON_B]);
  });
});

describe('bulk CSV import', () => {
  const row = (ack: string, addr: string, net = '') => `${ack},2026-09-01,Investment fraud,5000,${net},${addr}`;
  const CSV = [HEADER, row('A-1', TRON_A), row('A-2', ETH_A, 'ERC20'), row('A-1', TRON_B), row('A-3', 'bad-address'), row('A-4', TRON_A)].join('\n');

  async function upload(text: string, handler?: FetchHandler) {
    signInAs('INVESTIGATOR');
    const utils = mountApp('/intake', handler);
    await userEvent.click(screen.getByRole('tab', { name: 'Bulk CSV import' }));
    await userEvent.upload(screen.getByLabelText('CSV file'), csvFile(text));
    await screen.findByTestId('csv-summary');
    return utils;
  }

  it('previews rows with chain badges, validation errors, duplicate and linked-case markers', async () => {
    await upload(CSV);
    expect(screen.getByTestId('csv-summary')).toHaveTextContent('5 rows3 valid1 invalid1 duplicate');
    const table = screen.getByTestId('preview-table');
    expect(table.className).toContain('table-scroll'); // horizontal scroll container: wide tables never stretch the page
    for (const h of ['Row', 'Address', 'Chain', 'Date', 'Amount (INR)', 'Category', 'NCRP ack', 'Status', 'Markers']) expect(within(table).getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(table).getAllByText('TRON').length).toBeGreaterThan(0);
    expect(within(table).getByText('ETH')).toBeInTheDocument();
    expect(within(table).getByText(/bad-address: not a recognised/)).toBeInTheDocument();
    expect(within(table).getByText('Duplicate ack no. of row 1')).toBeInTheDocument();
    expect(within(table).getAllByText(/Linked to row/).length).toBe(2); // rows 1 and 5 share a wallet (the duplicate row 3 does not count)
    expect(screen.getByTestId('csv-summary')).toHaveTextContent('2 linked');
    expect(within(table).getAllByText('Fast path').length).toBe(2);
    expect(screen.getByRole('button', { name: 'Import 3 valid rows' })).toBeEnabled();
  });

  it('puts TRON rows first and filters by status', async () => {
    await upload(CSV);
    const first = within(screen.getByTestId('preview-table')).getAllByRole('row')[1];
    expect(first).toHaveAttribute('data-status', 'valid');
    await userEvent.click(screen.getByRole('button', { name: /^Invalid/ }));
    const rows = within(screen.getByTestId('preview-table')).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveAttribute('data-status', 'invalid');
  });

  it('imports only valid rows as text/csv and reports the counts the API returned', async () => {
    const { fetchMock } = await upload(CSV, (u, i) =>
      u.pathname === '/api/v1/complaints/import' && i.method === 'POST'
        ? json(200, {
            summary: { ...summary, total: 3, created: 2, duplicates: 1, invalid: 0, linked: 1, tronTraceJobs: 2, traceJobsPrepared: 2, queued: 2 },
            rows: [
              { ...created, row: 2, ackNo: 'A-1' },
              { row: 3, ackNo: 'A-2', status: 'CREATED', errors: [], warnings: [], caseId: 'case-2', linkedCaseIds: ['case-1234-abcd'], linkedAckNos: ['A-1'] },
              { row: 4, ackNo: 'A-4', status: 'DUPLICATE', duplicateOf: 'existing', errors: [], warnings: [], caseId: 'case-old' },
            ],
          })
        : undefined,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import 3 valid rows' }));
    const result = (await screen.findByRole('heading', { name: 'Import result' })).closest('section')!;
    const [url, init] = posts(fetchMock, '/complaints/import')[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/complaints/import');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/csv');
    const body = init.body as string;
    expect(body.split('\n')[0]).toBe('ackNo,reportedAt,category,amountInr,network,addresses,txHashes,tokenContract,firNumber');
    expect(body).toContain('A-1');
    expect(body).toContain('A-2');
    expect(body).toContain('A-4');
    expect(body).not.toContain('bad-address');
    expect(body.split('\n')).toHaveLength(4);
    expect(stat(result, 'Imported')).toHaveTextContent('2');
    expect(stat(result, 'Duplicates')).toHaveTextContent('1');
    expect(stat(result, 'Linked cases')).toHaveTextContent('1');
    expect(stat(result, 'TRON fast-path jobs')).toHaveTextContent('2');
    expect(stat(result, 'Not sent')).toHaveTextContent('2');
    expect(within(result).getByText('Linked case')).toBeInTheDocument();
    expect(within(result).getAllByRole('link', { name: /Open case/ })[0]).toHaveAttribute('href', expect.stringMatching(/^\/cases\//));
  });

  it('blocks a file with a missing required column and offers no import', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake');
    await userEvent.click(screen.getByRole('tab', { name: 'Bulk CSV import' }));
    await userEvent.upload(screen.getByLabelText('CSV file'), csvFile('ackNo,category\nA-1,x'));
    expect(await screen.findByText(/Missing required column\(s\): reportedAt, amountInr/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  it('rejects a non-CSV file', async () => {
    signInAs('INVESTIGATOR');
    mountApp('/intake');
    await userEvent.click(screen.getByRole('tab', { name: 'Bulk CSV import' }));
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [new File(['x'], 'notes.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByText(/is not a CSV file/)).toBeInTheDocument();
  });

  it('shows a friendly error when the import request fails', async () => {
    await upload(CSV, (u) => (u.pathname.endsWith('/complaints/import') ? json(500, { error: 'INTERNAL', message: 'SECRET' }) : undefined));
    await userEvent.click(screen.getByRole('button', { name: 'Import 3 valid rows' }));
    expect(await screen.findByText(/The server hit a problem/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Import result' })).not.toBeInTheDocument());
  });
});
