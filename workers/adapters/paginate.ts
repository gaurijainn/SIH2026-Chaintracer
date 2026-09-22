import type { ChainAdapter, GetTransfersOpts, Transfer } from '@ps26183/shared';

/** Opaque page cursor. s = stage (e.g. USDT before TRX), c = provider-specific position, p = provider it belongs to. */
export interface Cursor {
  s: number;
  c?: string;
  p?: string;
}

export const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(cursor?: string): Cursor {
  if (!cursor) return { s: 0 };
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.s !== 'number' || c.s < 0) throw new Error('bad stage');
    return c;
  } catch {
    throw new Error(`invalid cursor: ${cursor}`);
  }
}

export interface IterateOpts extends GetTransfersOpts {
  /** hard ceilings so a misbehaving provider can never loop forever */
  maxPages?: number;
  maxItems?: number;
}

export interface Collected {
  items: Transfer[];
  pages: number;
  /** true if a ceiling stopped the walk before the provider reported the end */
  truncated: boolean;
}

/**
 * Walks every page of an address's transfers and returns them de-duplicated by (txHash, idx, from, to).
 * Terminates when the provider stops returning a cursor, when a cursor repeats, or at the ceilings.
 * (De-duplication also absorbs the overlap that can occur if a provider fails over mid-walk.)
 */
export async function collectTransfers(adapter: ChainAdapter, addr: string, dir: 'in' | 'out', o: IterateOpts = {}): Promise<Collected> {
  const { maxPages = 500, maxItems = 100_000, ...q } = o;
  const seen = new Set<string>();
  const items: Transfer[] = [];
  const cursors = new Set<string>();
  let cursor = q.cursor;
  let pages = 0;
  for (;;) {
    const page = await adapter.getTransfers(addr, dir, { ...q, cursor });
    pages++;
    for (const t of page.items) {
      const k = `${t.txHash}|${t.idx}|${t.from}|${t.to}`;
      if (!seen.has(k)) {
        seen.add(k);
        items.push(t);
      }
    }
    if (!page.next) return { items, pages, truncated: false };
    if (cursors.has(page.next) || page.next === cursor) return { items, pages, truncated: false }; // provider looped: stop
    cursors.add(page.next);
    cursor = page.next;
    if (pages >= maxPages || items.length >= maxItems) return { items, pages, truncated: true };
  }
}
