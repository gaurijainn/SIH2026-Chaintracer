/// <reference lib="webworker" />
import { parseCsvSource, type CsvParseResult, type ParseProgress } from './csvCore';

export type WorkerRequest = { type: 'parse'; file: File };
export type WorkerMessage = { type: 'progress'; progress: ParseProgress } | { type: 'done'; result: CsvParseResult };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Parses and validates the file off the main thread; posts progress per chunk and the full result at the end. */
ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  if (ev.data.type !== 'parse') return;
  void parseCsvSource(ev.data.file, (progress) => ctx.postMessage({ type: 'progress', progress } satisfies WorkerMessage)).then((result) =>
    ctx.postMessage({ type: 'done', result } satisfies WorkerMessage),
  );
};
