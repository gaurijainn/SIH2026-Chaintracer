import { parseCsvSource, type CsvParseResult, type ParseProgress } from './csvCore';
import type { WorkerMessage } from './csv.worker';

export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

export interface ParseHandle {
  promise: Promise<CsvParseResult>;
  cancel: () => void;
}

export const defaultWorkerFactory = (): WorkerLike | null =>
  typeof Worker === 'undefined' ? null : (new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);

/**
 * Parses a CSV File in a Web Worker so large files never freeze the page. Only when Workers do not exist
 * (or fail to start) does it fall back to parsing on the main thread, in 256 KB chunks.
 */
export function parseCsvFile(file: File, onProgress?: (p: ParseProgress) => void, workerFactory: () => WorkerLike | null = defaultWorkerFactory): ParseHandle {
  let worker: WorkerLike | null = null;
  try {
    worker = workerFactory();
  } catch {
    worker = null;
  }
  if (!worker) return { promise: parseCsvSource(file, onProgress), cancel: () => undefined };
  const w = worker;
  let cancelled = false;
  const promise = new Promise<CsvParseResult>((resolve, reject) => {
    w.onmessage = (ev) => {
      if (ev.data.type === 'progress') onProgress?.(ev.data.progress);
      else {
        w.terminate();
        resolve(ev.data.result);
      }
    };
    w.onerror = () => {
      w.terminate();
      if (cancelled) return;
      // worker failed to start (e.g. blocked): degrade to the main thread rather than losing the upload
      parseCsvSource(file, onProgress).then(resolve, reject);
    };
    w.postMessage({ type: 'parse', file });
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      w.terminate();
    },
  };
}
