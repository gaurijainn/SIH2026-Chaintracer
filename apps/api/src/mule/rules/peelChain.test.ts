import { describe, expect, it } from 'vitest';
import type { HopLike } from '../types';
import { detectBtcPeelChain } from './peelChain';

const T0 = Date.UTC(2026, 8, 1);
const hop = (over: Partial<HopLike>): HopLike => ({ txHash: 'tx', idx: 0, fromAddr: 'F', toAddr: 'T', token: 'BTC', amount: '1', usd: 1, ts: T0, ...over });

/** A -> (B peel, X change), B -> (C peel, Y change), C -> (D peel, Z change): a 3-hop peel chain. */
function peelChainHops(): HopLike[] {
  return [
    hop({ txHash: 'tx1', idx: 0, fromAddr: 'A', toAddr: 'B', amount: '10' }),
    hop({ txHash: 'tx1', idx: 1, fromAddr: 'A', toAddr: 'X', amount: '0.1' }),
    hop({ txHash: 'tx2', idx: 0, fromAddr: 'B', toAddr: 'C', amount: '9.8' }),
    hop({ txHash: 'tx2', idx: 1, fromAddr: 'B', toAddr: 'Y', amount: '0.1' }),
    hop({ txHash: 'tx3', idx: 0, fromAddr: 'C', toAddr: 'D', amount: '9.6' }),
    hop({ txHash: 'tx3', idx: 1, fromAddr: 'C', toAddr: 'Z', amount: '0.1' }),
  ];
}

describe('detectBtcPeelChain', () => {
  it('detects a 3-hop peel chain of single-input, two-output transactions', () => {
    const [m] = detectBtcPeelChain(peelChainHops());
    expect(m.addresses).toEqual(['A', 'B', 'C', 'D']);
    expect(m.confidence).toBe(0.8);
    expect(m.evidence).toMatchObject({ chainLength: 3, txHashes: ['tx1', 'tx2', 'tx3'] });
  });

  it('does not classify a single 2-output payment as a peel chain', () => {
    const hops = [hop({ txHash: 'tx1', idx: 0, fromAddr: 'A', toAddr: 'B', amount: '5' }), hop({ txHash: 'tx1', idx: 1, fromAddr: 'A', toAddr: 'X', amount: '5' })];
    expect(detectBtcPeelChain(hops)).toEqual([]);
  });

  it('does not classify two independent hops (no forwarding relationship) as a peel chain', () => {
    const hops = [
      hop({ txHash: 'tx1', idx: 0, fromAddr: 'A', toAddr: 'B', amount: '5' }),
      hop({ txHash: 'tx1', idx: 1, fromAddr: 'A', toAddr: 'X', amount: '5' }),
      hop({ txHash: 'tx2', idx: 0, fromAddr: 'M', toAddr: 'N', amount: '3' }),
      hop({ txHash: 'tx2', idx: 1, fromAddr: 'M', toAddr: 'Y', amount: '3' }),
    ];
    expect(detectBtcPeelChain(hops)).toEqual([]);
  });

  it('does not fire on a chain shorter than the configured minimum length', () => {
    const hops = peelChainHops().slice(0, 4); // only A->B and B->C: chain length 2
    expect(detectBtcPeelChain(hops)).toEqual([]);
  });

  it('does not treat a multi-output (3+) transaction as a peel leg beyond maxOutputsPerTx', () => {
    const hops: HopLike[] = [
      hop({ txHash: 'tx1', idx: 0, fromAddr: 'A', toAddr: 'B', amount: '5' }),
      hop({ txHash: 'tx1', idx: 1, fromAddr: 'A', toAddr: 'X', amount: '2' }),
      hop({ txHash: 'tx1', idx: 2, fromAddr: 'A', toAddr: 'Y', amount: '2' }),
      hop({ txHash: 'tx1', idx: 3, fromAddr: 'A', toAddr: 'Z', amount: '1' }), // 4 outputs, exceeds default max of 3
      hop({ txHash: 'tx2', idx: 0, fromAddr: 'B', toAddr: 'C', amount: '4.8' }),
      hop({ txHash: 'tx2', idx: 1, fromAddr: 'B', toAddr: 'W', amount: '0.1' }),
    ];
    expect(detectBtcPeelChain(hops)).toEqual([]);
  });

  it('respects a configured minChainLength override', () => {
    const hops = peelChainHops().slice(0, 4); // chain length 2
    expect(detectBtcPeelChain(hops, { minChainLength: 2, maxOutputsPerTx: 3 })).toHaveLength(1);
  });
});
