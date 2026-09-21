import { createHash } from 'node:crypto';
import type { Chain } from '@ps26183/shared';
import type { ChainProbe } from './probe';
import type { TraceJobPayload, TraceQueue } from './queue';
import type { RawComplaint } from './types';

// Test helpers: build checksum-valid, unique, synthetic identifiers from a seed string.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

function base58(buf: Buffer): string {
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}

export function tronAddress(seed: string): string {
  const payload = Buffer.concat([Buffer.from([0x41]), sha(`tron:${seed}`).subarray(0, 20)]);
  return base58(Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]));
}

/** lower-case 0x address; the pipeline normalises it to EIP-55 */
export const evmAddress = (seed: string) => `0x${sha(`evm:${seed}`).subarray(0, 20).toString('hex')}`;
export const txHash = (seed: string) => sha(`tx:${seed}`).toString('hex');

export function complaint(ackNo: string, over: RawComplaint = {}): RawComplaint {
  return {
    ackNo,
    reportedAt: '2026-09-01T08:30:00+05:30',
    category: 'Investment fraud',
    amountInr: '100000',
    network: 'TRC20',
    addresses: [tronAddress(ackNo)],
    ...over,
  };
}

/** Scripted probe: `active[chain]` lists addresses/hashes that exist there; everything else is inactive. */
export function fakeProbe(active: Partial<Record<Chain, string[]>> = {}, opts: { fail?: Chain[] } = {}) {
  const calls: string[] = [];
  const probe: ChainProbe = {
    async addressActive(chain, addr) {
      calls.push(`addr:${chain}:${addr}`);
      if (opts.fail?.includes(chain)) throw new Error('provider down');
      return (active[chain] ?? []).includes(addr);
    },
    async txExists(chain, hash) {
      calls.push(`tx:${chain}:${hash}`);
      if (opts.fail?.includes(chain)) throw new Error('provider down');
      return (active[chain] ?? []).includes(hash);
    },
  };
  return { probe, calls };
}

/** Records enqueue() calls in order; can be told to fail. */
export class RecordingQueue implements TraceQueue {
  batches: TraceJobPayload[][] = [];
  fail = false;
  get jobs() {
    return this.batches.flat();
  }
  async enqueue(jobs: TraceJobPayload[]) {
    if (this.fail) throw new Error('redis down');
    // mirror BullTraceQueue: TRON before everything else
    this.batches.push([...jobs.filter((j) => j.chain === 'TRON'), ...jobs.filter((j) => j.chain !== 'TRON')]);
    return jobs.length;
  }
  async close() {}
}

/** checksum-valid P2PKH Bitcoin address derived from a seed */
export function btcAddress(seed: string): string {
  const payload = Buffer.concat([Buffer.from([0x00]), sha(`btc:${seed}`).subarray(0, 20)]);
  return '1' + base58(Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]));
}
