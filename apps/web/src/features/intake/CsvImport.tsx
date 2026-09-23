import { FileSpreadsheet, TriangleAlert, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { StatusBadge } from '@/components/common/badges';
import { SectionCard } from '@/components/common/cards';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/skeleton';
import { toApiError } from '@/lib/api/errors';
import { cn } from '@/lib/cn';
import { useImportComplaints, type ImportResponse } from './api';
import { toImportCsv, type CsvParseResult, type ParseProgress } from './csvCore';
import { parseCsvFile, type ParseHandle, type WorkerLike } from './parseCsv';
import { ImportResult } from './ResultPanels';
import { RowsPreview } from './RowsPreview';
import { MAX_ROWS } from './rules';

const isCsv = (f: File) => /\.csv$/i.test(f.name) || /csv|text\/plain/i.test(f.type);

/** Drag-and-drop / file-picker CSV import. Parsing and validation run in a Web Worker; only valid, non-duplicate rows are sent. */
export function CsvImport({ workerFactory }: { workerFactory?: () => WorkerLike | null }) {
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [parsed, setParsed] = useState<CsvParseResult | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{ data: ImportResponse; skipped: number } | null>(null);
  const handle = useRef<ParseHandle | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const importer = useImportComplaints();

  useEffect(() => () => handle.current?.cancel(), []);

  const start = useCallback(
    (f: File) => {
      handle.current?.cancel();
      setResult(null);
      importer.reset();
      setParsed(null);
      setFileProblem(null);
      if (!isCsv(f)) {
        setFile(null);
        setFileProblem(`"${f.name}" is not a CSV file. Choose a .csv file.`);
        return;
      }
      setFile(f);
      setParsing(true);
      setProgress({ rows: 0, percent: 0 });
      const h = parseCsvFile(f, setProgress, workerFactory);
      handle.current = h;
      h.promise
        .then((r) => {
          if (handle.current !== h) return;
          setParsed(r);
        })
        .catch(() => setFileProblem('The file could not be read. Try again or check that it is a valid CSV.'))
        .finally(() => {
          if (handle.current === h) setParsing(false);
        });
    },
    [workerFactory],
  );

  const clear = () => {
    handle.current?.cancel();
    handle.current = null;
    setFile(null);
    setParsed(null);
    setParsing(false);
    setResult(null);
    setFileProblem(null);
    importer.reset();
    if (input.current) input.current.value = '';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) start(f);
  };

  const stats = useMemo(() => {
    const rows = parsed?.rows ?? [];
    const valid = rows.filter((r) => r.status === 'valid');
    return {
      total: rows.length,
      valid,
      invalid: rows.filter((r) => r.status === 'invalid').length,
      duplicate: rows.filter((r) => r.status === 'duplicate').length,
      linked: rows.filter((r) => r.linkedRows.length > 0).length,
      tron: valid.filter((r) => r.tron).length,
    };
  }, [parsed]);

  const blocked = !parsed || parsed.fileErrors.length > 0 || stats.valid.length === 0;
  const submit = () => {
    if (!parsed || blocked) return;
    const skipped = stats.total - stats.valid.length;
    importer.mutate(toImportCsv(stats.valid), { onSuccess: (data) => setResult({ data, skipped }) });
  };

  return (
    <div className="space-y-4">
      <SectionCard title="Bulk import" description={`Upload a CSV of NCRP complaints (up to ${MAX_ROWS.toLocaleString()} rows, 25 MB). Required columns: ackNo, reportedAt, category, amountInr. Optional: network, addresses, txHashes, tokenContract, firNumber. Separate several addresses in one cell with ;`}>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          data-testid="dropzone"
          className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors motion-reduce:transition-none', dragging ? 'border-primary bg-accent' : 'border-border')}
        >
          <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">Drag and drop a CSV file here</p>
          <p className="text-xs text-muted-foreground">or</p>
          <input ref={input} id="csv-file" type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => e.target.files?.[0] && start(e.target.files[0])} />
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            Choose CSV file
          </Button>
        </div>
        {fileProblem && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-risk-critical">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {fileProblem}
          </p>
        )}
      </SectionCard>

      {file && (
        <SectionCard
          title="Preview"
          actions={
            <Button variant="ghost" size="sm" onClick={clear} disabled={importer.isPending} aria-label="Remove file">
              <X aria-hidden="true" /> Remove
            </Button>
          }
          description={file.name}
          bodyClassName="space-y-4"
        >
          {parsing && (
            <div role="status" aria-live="polite" className="space-y-2">
              <p className="flex items-center gap-2 text-sm">
                <Spinner label="Parsing" /> Parsing and validating… {progress?.rows.toLocaleString()} rows
                {progress?.percent != null && ` (${progress.percent}%)`}
              </p>
              <div className="h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-label="Parsing progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress?.percent ?? undefined}>
                <div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${progress?.percent ?? 0}%` }} />
              </div>
            </div>
          )}

          {parsed && (
            <>
              {parsed.fileErrors.length > 0 && (
                <div role="alert" className="rounded-md border border-risk-critical/50 bg-risk-critical-soft px-3 py-2 text-sm text-risk-critical">
                  <p className="font-medium">This file cannot be imported as it is:</p>
                  <ul className="mt-1 list-inside list-disc">
                    {parsed.fileErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
              {parsed.ignoredColumns.length > 0 && <p className="text-xs text-muted-foreground">Ignored columns (not part of the import): {parsed.ignoredColumns.join(', ')}</p>}

              {parsed.rows.length > 0 && (
                <>
                  <p role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="csv-summary">
                    <span>
                      <strong>{stats.total.toLocaleString()}</strong> rows
                    </span>
                    <span className="text-risk-low">{stats.valid.length.toLocaleString()} valid</span>
                    <span className={stats.invalid ? 'text-risk-critical' : 'text-muted-foreground'}>{stats.invalid.toLocaleString()} invalid</span>
                    <span className={stats.duplicate ? 'text-risk-medium' : 'text-muted-foreground'}>{stats.duplicate.toLocaleString()} duplicate</span>
                    <span className="text-muted-foreground">{stats.linked.toLocaleString()} linked</span>
                    {stats.tron > 0 && <StatusBadge tone="info">{stats.tron.toLocaleString()} TRON fast path</StatusBadge>}
                  </p>
                  <RowsPreview rows={parsed.rows} />
                </>
              )}

              {parsed.rows.length === 0 && parsed.fileErrors.length === 0 && <p className="text-sm text-muted-foreground">No rows to preview.</p>}

              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={submit} disabled={blocked || importer.isPending}>
                  {importer.isPending ? <Spinner label="Importing" /> : <FileSpreadsheet aria-hidden="true" />}
                  {importer.isPending ? 'Importing…' : `Import ${stats.valid.length.toLocaleString()} valid ${stats.valid.length === 1 ? 'row' : 'rows'}`}
                </Button>
                {stats.total - stats.valid.length > 0 && <span className="text-xs text-muted-foreground">{(stats.total - stats.valid.length).toLocaleString()} invalid or duplicate rows will not be sent.</span>}
              </div>
              {importer.isError && (
                <p role="alert" className="flex items-start gap-2 rounded-md border border-risk-critical/50 bg-risk-critical-soft px-3 py-2 text-sm text-risk-critical">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {toApiError(importer.error).message}
                </p>
              )}
            </>
          )}
        </SectionCard>
      )}

      {result && <ImportResult result={result.data} skippedLocally={result.skipped} />}
    </div>
  );
}
