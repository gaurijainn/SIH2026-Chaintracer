import { zodResolver } from '@hookform/resolvers/zod';
import { CircleAlert, CircleCheck, CopyMinus, Send } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { ChainBadge, StatusBadge } from '@/components/common/badges';
import { SectionCard } from '@/components/common/cards';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/skeleton';
import { toApiError } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { rowIssuesOf, useCreateComplaint, type CreateComplaintResponse } from './api';
import { CATEGORY_SUGGESTIONS, emptyComplaint, makeComplaintSchema, type ComplaintFormValues, type IntakeMode } from './complaintSchema';
import { parsePastedAddresses, type PasteRow } from './paste';
import { ComplaintResult } from './ResultPanels';
import { classifyIdentifier, guessChain, NETWORKS, type Network } from './rules';
import { TronFastPathNote, TronFastPathTag } from './TronFastPath';

const FIELD_OF: Record<string, keyof ComplaintFormValues> = { ackNo: 'ackNo', reportedAt: 'reportedAt', category: 'category', amountInr: 'amountInr', network: 'network', firNumber: 'firNumber' };
const fieldOf = (issueField: string): keyof ComplaintFormValues => FIELD_OF[issueField] ?? 'addresses';

function Field({ id, label, required, error, hint, children }: { id: string; label: string; required?: boolean; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required ? (
          <span className="ml-0.5 text-risk-critical" aria-hidden="true">
            *
          </span>
        ) : (
          <span className="ml-1.5 text-xs font-normal text-muted-foreground">(optional)</span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-risk-critical">
          {error}
        </p>
      )}
    </div>
  );
}

const PASTE_STATUS: Record<PasteRow['status'], { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }> = {
  valid: { label: 'Valid', tone: 'success' },
  invalid: { label: 'Invalid', tone: 'danger' },
  duplicate: { label: 'Duplicate', tone: 'warning' },
  'needs-chain': { label: 'Select chain', tone: 'warning' },
};

function PastePreview({ rows, summary }: { rows: PasteRow[]; summary: ReturnType<typeof parsePastedAddresses>['summary'] }) {
  if (rows.length === 0) return <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">Pasted addresses are checked here as you type.</p>;
  return (
    <div className="space-y-2" data-testid="paste-preview">
      <p role="status" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>
          <strong>{summary.total}</strong> entries
        </span>
        <span className="text-risk-low">{summary.valid} valid</span>
        <span className={summary.invalid ? 'text-risk-critical' : 'text-muted-foreground'}>{summary.invalid} invalid</span>
        <span className={summary.duplicate ? 'text-risk-medium' : 'text-muted-foreground'}>{summary.duplicate} duplicate</span>
        {summary.needsChain > 0 && <span className="text-risk-medium">{summary.needsChain} need a chain</span>}
      </p>
      <div className="table-scroll max-h-72 overflow-y-auto">
        <table className="w-full min-w-max border-collapse text-sm">
          <caption className="sr-only">Pasted addresses with validation status</caption>
          <thead className="sticky top-0 bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Line</th>
              <th scope="col" className="px-3 py-2 font-medium">Address</th>
              <th scope="col" className="px-3 py-2 font-medium">Chain</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const st = PASTE_STATUS[r.status];
              const icon = r.status === 'valid' ? <CircleCheck className="size-3" aria-hidden="true" /> : r.status === 'duplicate' ? <CopyMinus className="size-3" aria-hidden="true" /> : <CircleAlert className="size-3" aria-hidden="true" />;
              return (
                <tr key={`${r.line}-${r.raw}`} className={cn(r.chain === 'TRON' && r.status === 'valid' && 'border-l-2 border-l-chain-tron')}>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.line}</td>
                  <td className="max-w-[22rem] break-all px-3 py-2 font-mono text-xs">{r.raw}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap items-center gap-1">
                      {r.chain ? <ChainBadge chain={r.chain} /> : r.candidates.map((c) => <ChainBadge key={c} chain={c} className="opacity-60" />)}
                      {r.kind === 'TX_HASH' && <StatusBadge>Tx hash</StatusBadge>}
                      {r.chain === 'TRON' && r.status === 'valid' && <TronFastPathTag />}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge tone={st.tone} icon={icon}>
                      {st.label}
                    </StatusBadge>
                    {r.error && <span className="ml-2 text-xs text-risk-critical">{r.error}</span>}
                    {r.status === 'duplicate' && <span className="ml-2 text-xs text-muted-foreground">same as line {r.duplicateOfLine}; sent once</span>}
                    {r.status === 'needs-chain' && <span className="ml-2 text-xs text-muted-foreground">EVM address: pick a network above</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Single complaint (one wallet) or pasted addresses (several wallets on ONE complaint: the API's unit is a complaint with an NCRP acknowledgement number). */
export function ComplaintForm({ mode }: { mode: IntakeMode }) {
  const schema = useMemo(() => makeComplaintSchema(mode), [mode]);
  const create = useCreateComplaint();
  const [result, setResult] = useState<CreateComplaintResponse | null>(null);
  const [serverProbe, setServerProbe] = useState(false);
  const {
    register,
    handleSubmit,
    watch,
    reset,
    setError,
    formState: { errors },
  } = useForm<ComplaintFormValues>({ resolver: zodResolver(schema), defaultValues: emptyComplaint });

  const network = (watch('network') || null) as Network | null;
  const addressText = watch('addresses');
  const paste = useMemo(() => parsePastedAddresses(addressText, network, serverProbe), [addressText, network, serverProbe]);
  const single = useMemo(() => {
    const t = addressText.trim();
    if (!t || mode !== 'single') return null;
    const c = classifyIdentifier(t);
    return c.kind === 'ADDRESS' ? guessChain(c.family, network) : null;
  }, [addressText, network, mode]);

  const tronSelected = network === 'TRC20';
  const tronCount = mode === 'paste' ? paste.summary.tron : single?.chain === 'TRON' ? 1 : 0;
  const busy = create.isPending;

  const submit = handleSubmit((values) => {
    let addresses: string[];
    if (mode === 'single') addresses = [values.addresses.trim()];
    else {
      if (paste.summary.needsChain > 0) return setError('addresses', { message: 'Choose a network for the EVM addresses, or let the server detect the chain.' });
      addresses = paste.rows.filter((r) => r.status === 'valid').map((r) => r.raw);
    }
    create.mutate(
      { values, addresses },
      {
        onSuccess: (res) => {
          setResult(res);
          reset(emptyComplaint);
        },
        onError: (e) => {
          setResult(null);
          for (const i of rowIssuesOf(e) ?? []) setError(fieldOf(i.field), { message: i.message });
        },
      },
    );
  });

  const rejected = create.isError ? rowIssuesOf(create.error) : null;
  const inputProps = (name: keyof ComplaintFormValues) => ({ 'aria-invalid': !!errors[name], 'aria-describedby': errors[name] ? `${name}-error` : undefined, disabled: busy });
  const idp = mode === 'single' ? 's' : 'p';
  const label = mode === 'single' ? 'Register complaint' : `Register complaint with ${paste.summary.valid} ${paste.summary.valid === 1 ? 'address' : 'addresses'}`;

  return (
    <div className="space-y-4">
      <SectionCard
        title={mode === 'single' ? 'Single complaint' : 'Paste addresses'}
        description={mode === 'single' ? 'Register one NCRP complaint with its suspect wallet. Fields marked * are required.' : 'One address per line. All pasted addresses are registered on one complaint (up to 50). Fields marked * are required.'}
      >
        <form onSubmit={submit} noValidate aria-label={mode === 'single' ? 'Single complaint' : 'Paste addresses'} className="space-y-4">
          {create.isError && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-risk-critical/50 bg-risk-critical-soft px-3 py-2 text-sm text-risk-critical">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{rejected ? 'The complaint was not accepted. Review the highlighted problems and try again.' : toApiError(create.error).message}</span>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${idp}-ackNo`} label="NCRP acknowledgement number" required error={errors.ackNo?.message}>
              <Input id={`${idp}-ackNo`} autoComplete="off" placeholder="e.g. 31509260001234" {...inputProps('ackNo')} {...register('ackNo')} />
            </Field>
            <Field id={`${idp}-reportedAt`} label="Complaint date and time (IST)" required error={errors.reportedAt?.message} hint="Read as IST. Cannot be in the future.">
              <Input id={`${idp}-reportedAt`} type="datetime-local" {...inputProps('reportedAt')} {...register('reportedAt')} />
            </Field>
            <Field id={`${idp}-amountInr`} label="Amount lost (INR)" required error={errors.amountInr?.message}>
              <Input id={`${idp}-amountInr`} inputMode="decimal" autoComplete="off" placeholder="e.g. 250000.00" {...inputProps('amountInr')} {...register('amountInr')} />
            </Field>
            <Field id={`${idp}-category`} label="Category" required error={errors.category?.message}>
              <Input id={`${idp}-category`} list={`${idp}-categories`} autoComplete="off" placeholder="e.g. Investment fraud" {...inputProps('category')} {...register('category')} />
              <datalist id={`${idp}-categories`}>
                {CATEGORY_SUGGESTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field id={`${idp}-network`} label="Network" error={errors.network?.message} hint="Leave on auto-detect unless the victim named the network. TRON and Bitcoin addresses are detected from their format.">
              <select id={`${idp}-network`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60" {...inputProps('network')} {...register('network')}>
                <option value="">Auto-detect</option>
                {NETWORKS.map((n) => (
                  <option key={n.value} value={n.value}>
                    {n.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`${idp}-firNumber`} label="FIR number" error={errors.firNumber?.message}>
              <Input id={`${idp}-firNumber`} autoComplete="off" {...inputProps('firNumber')} {...register('firNumber')} />
            </Field>
          </div>

          <Field
            id={`${idp}-addresses`}
            label={mode === 'single' ? 'Suspect wallet address' : 'Suspect wallet addresses'}
            required
            error={errors.addresses?.message}
            hint={mode === 'single' ? 'TRON (T…), Ethereum/BSC/Polygon (0x…) or Bitcoin address.' : 'One per line. Blank lines are ignored; duplicates are flagged and sent once.'}
          >
            {mode === 'single' ? (
              <div className="space-y-2">
                <Input id={`${idp}-addresses`} className="font-mono" autoComplete="off" spellCheck={false} placeholder="TRON, ETH/BSC/Polygon or BTC address" {...inputProps('addresses')} {...register('addresses')} />
                {single && (
                  <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="detected-chain">
                    Detected:
                    {single.chain ? <ChainBadge chain={single.chain} /> : single.candidates.map((c) => <ChainBadge key={c} chain={c} className="opacity-60" />)}
                    {single.chain === 'TRON' && <TronFastPathTag />}
                    {!single.chain && <span>EVM address: pick ERC20 or BEP20 above, or the server probes the chains.</span>}
                  </p>
                )}
              </div>
            ) : (
              <textarea
                id={`${idp}-addresses`}
                rows={6}
                spellCheck={false}
                placeholder={'One address per line'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs placeholder:text-muted-foreground disabled:opacity-60 aria-[invalid=true]:border-risk-critical"
                {...inputProps('addresses')}
                {...register('addresses')}
              />
            )}
          </Field>

          {(tronSelected || tronCount > 0) && <TronFastPathNote count={tronCount || undefined} />}

          {mode === 'paste' && (
            <>
              {paste.summary.needsChain > 0 && (
                <div role="note" className="rounded-md border border-risk-medium/40 bg-risk-medium-soft px-3 py-2 text-sm text-risk-medium">
                  <p>
                    {paste.summary.needsChain} EVM {paste.summary.needsChain === 1 ? 'address is' : 'addresses are'} valid on ETH, BSC and Polygon, so the chain cannot be safely inferred. Select ERC20 or BEP20 as the network, or
                  </p>
                  <label className="mt-1 flex items-center gap-2">
                    <input type="checkbox" checked={serverProbe} onChange={(e) => setServerProbe(e.target.checked)} className="size-4" />
                    let the server detect the chain (it probes ETH, BSC and Polygon)
                  </label>
                </div>
              )}
              <PastePreview rows={paste.rows} summary={paste.summary} />
            </>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner label="Submitting" /> : <Send aria-hidden="true" />}
              {busy ? 'Submitting…' : label}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                reset(emptyComplaint);
                setResult(null);
                create.reset();
              }}
            >
              Clear
            </Button>
          </div>
        </form>
      </SectionCard>
      {result && <ComplaintResult result={result} />}
    </div>
  );
}
