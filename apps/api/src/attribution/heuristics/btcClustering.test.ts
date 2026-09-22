import { describe, expect, it } from 'vitest';
import { clusterBtcTransactions, isCoinJoinLike, UnionFind, type BtcTx } from './btcClustering';

describe('UnionFind', () => {
  it('starts every address as its own singleton cluster', () => {
    const uf = new UnionFind();
    expect(uf.find('a')).toBe('a');
    expect(uf.find('a')).not.toBe(uf.find('b'));
  });
  it('merges two addresses into the same cluster root after union', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    expect(uf.find('a')).toBe(uf.find('b'));
  });
  it('is transitive: unioning through a chain merges everyone', () => {
    const uf = new UnionFind();
    uf.union('a', 'b');
    uf.union('b', 'c');
    expect(uf.find('a')).toBe(uf.find('c'));
  });
});

describe('isCoinJoinLike', () => {
  it('flags a transaction with 3+ equal-value outputs', () => {
    const tx: BtcTx = { txid: 't', inputs: ['a', 'b', 'c'], outputs: [{ addr: 'x', value: 100 }, { addr: 'y', value: 100 }, { addr: 'z', value: 100 }] };
    expect(isCoinJoinLike(tx)).toBe(true);
  });
  it('does not flag a normal transaction with distinct output values', () => {
    const tx: BtcTx = { txid: 't', inputs: ['a', 'b'], outputs: [{ addr: 'x', value: 100 }, { addr: 'y', value: 50 }] };
    expect(isCoinJoinLike(tx)).toBe(false);
  });
  it('does not flag a transaction with too few outputs to look like a mix', () => {
    const tx: BtcTx = { txid: 't', inputs: ['a', 'b'], outputs: [{ addr: 'x', value: 100 }, { addr: 'y', value: 100 }] };
    expect(isCoinJoinLike(tx)).toBe(false);
  });
});

describe('clusterBtcTransactions (H3)', () => {
  it('clusters every input address of a normal multi-input transaction together', () => {
    const { uf, clustered, skipped } = clusterBtcTransactions([{ txid: 't1', inputs: ['a', 'b', 'c'], outputs: [{ addr: 'x', value: 100 }] }]);
    expect(uf.find('a')).toBe(uf.find('b'));
    expect(uf.find('a')).toBe(uf.find('c'));
    expect(clustered).toEqual(['t1']);
    expect(skipped).toEqual([]);
  });

  it('skips a CoinJoin-like transaction: its inputs stay in separate clusters', () => {
    const tx: BtcTx = { txid: 't1', inputs: ['a', 'b', 'c'], outputs: [{ addr: 'x', value: 100 }, { addr: 'y', value: 100 }, { addr: 'z', value: 100 }] };
    const { uf, skipped, clustered } = clusterBtcTransactions([tx]);
    expect(uf.find('a')).not.toBe(uf.find('b'));
    expect(skipped).toEqual(['t1']);
    expect(clustered).toEqual([]);
  });

  it('leaves a single-input transaction unclustered (no ownership signal)', () => {
    const { clustered } = clusterBtcTransactions([{ txid: 't1', inputs: ['a'], outputs: [{ addr: 'x', value: 100 }] }]);
    expect(clustered).toEqual([]);
  });

  it('transitively merges clusters across multiple normal transactions', () => {
    const { uf } = clusterBtcTransactions([
      { txid: 't1', inputs: ['a', 'b'], outputs: [{ addr: 'x', value: 1 }] },
      { txid: 't2', inputs: ['b', 'c'], outputs: [{ addr: 'y', value: 1 }] },
    ]);
    expect(uf.find('a')).toBe(uf.find('c'));
  });
});
