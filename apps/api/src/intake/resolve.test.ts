import { describe, expect, it } from 'vitest';
import { USDT_ERC20, USDT_TRC20 } from '@ps26183/shared';
import { normalizeComplaint } from './normalize';
import { createProbeRunner } from './probe';
import { resolveEntries } from './resolve';
import { seedChainsOf, type NormalizedComplaint, type RawComplaint } from './types';
import { complaint, evmAddress, fakeProbe, tronAddress, txHash } from './testutil';

const norm = (over: RawComplaint): NormalizedComplaint => {
  const r = normalizeComplaint({ ...complaint('ACK-R'), ...over }, new Date('2026-09-20T00:00:00Z'));
  if (!r.value) throw new Error(JSON.stringify(r.errors));
  return r.value;
};
const run = async (c: NormalizedComplaint, probe = fakeProbe()) => ({ ...(await resolveEntries(c, createProbeRunner(probe.probe))), calls: probe.calls });
const evm = (seed: string) => norm({ addresses: [evmAddress(seed)], network: undefined }).entries[0].value;

describe('TRON fast path', () => {
  it('resolves TRON addresses by format alone: no probing at all', async () => {
    const { entries, calls } = await run(norm({ addresses: [tronAddress('a'), tronAddress('b')] }));
    expect(calls).toEqual([]);
    expect(entries.map((e) => [e.chain, e.candidateChains, e.flags])).toEqual([['TRON', [], []], ['TRON', [], []]]);
    expect(entries.flatMap(seedChainsOf)).toEqual(['TRON', 'TRON']);
  });

  it('resolves Bitcoin by format alone', async () => {
    const { entries, calls } = await run(norm({ addresses: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'], network: undefined }));
    expect(calls).toEqual([]);
    expect(entries[0].chain).toBe('BTC');
  });

  it('warns when the stated network contradicts the address format (format wins)', async () => {
    const { entries, warnings } = await run(norm({ addresses: [tronAddress('a')], network: 'ERC20' }));
    expect(entries[0].chain).toBe('TRON');
    expect(warnings.map((w) => w.code)).toEqual(['NETWORK_MISMATCH']);
  });
});

describe('EVM ambiguity', () => {
  it('uses the complaint network first and does not probe', async () => {
    const a = evmAddress('n');
    for (const [network, chain] of [['ERC20', 'ETH'], ['BEP20', 'BSC']] as const) {
      const { entries, calls } = await run(norm({ addresses: [a], network }));
      expect(entries[0]).toMatchObject({ chain, candidateChains: [], flags: [] });
      expect(calls).toEqual([]);
    }
  });

  it('probes ETH, BSC and Polygon in parallel and keeps the chain with activity', async () => {
    const a = evm('one');
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const probe = {
      addressActive: async (chain: string) => {
        started.push(chain);
        await gate; // nothing can finish until all three have started => proves parallel probing
        return chain === 'BSC';
      },
      txExists: async () => false,
    };
    const p = resolveEntries(norm({ addresses: [a], network: undefined }), createProbeRunner(probe as never));
    await new Promise((r) => setTimeout(r, 20));
    expect(started.sort()).toEqual(['BSC', 'ETH', 'POLYGON']);
    release();
    const { entries } = await p;
    expect(entries[0]).toMatchObject({ chain: 'BSC', candidateChains: [], flags: ['CHAIN_PROBED'] });
  });

  it('keeps every chain with activity and flags the address ambiguous', async () => {
    const a = evm('two');
    const { entries, warnings } = await run(norm({ addresses: [a], network: undefined }), fakeProbe({ ETH: [a], POLYGON: [a] }));
    expect(entries[0]).toMatchObject({ chain: null, candidateChains: ['ETH', 'POLYGON'], flags: ['AMBIGUOUS_CHAIN'] });
    expect(seedChainsOf(entries[0])).toEqual(['ETH', 'POLYGON']);
    expect(warnings.map((w) => w.code)).toContain('AMBIGUOUS_CHAIN');
  });

  it('flags NO_ACTIVITY and queues nothing when no chain has activity', async () => {
    const { entries } = await run(norm({ addresses: [evm('three')], network: undefined }));
    expect(entries[0]).toMatchObject({ chain: null, candidateChains: ['ETH', 'BSC', 'POLYGON'], flags: ['NO_ACTIVITY'] });
    expect(seedChainsOf(entries[0])).toEqual([]);
  });

  it('keeps unverifiable chains as candidates when the provider is down, rather than dropping them', async () => {
    const { entries } = await run(norm({ addresses: [evm('four')], network: undefined }), fakeProbe({}, { fail: ['ETH', 'BSC', 'POLYGON'] }));
    expect(entries[0].flags).toEqual(['AMBIGUOUS_CHAIN', 'PROBE_UNAVAILABLE']);
    expect(seedChainsOf(entries[0])).toEqual(['ETH', 'BSC', 'POLYGON']);
  });

  it('treats a missing probe as unknown for every chain', async () => {
    const r = await resolveEntries(norm({ addresses: [evm('five')], network: undefined }), createProbeRunner(null));
    expect(r.entries[0].flags).toContain('PROBE_UNAVAILABLE');
  });

  it('a TRC20 network with an EVM address is a mismatch and falls back to probing', async () => {
    const a = evm('six');
    const { entries, warnings } = await run(norm({ addresses: [a], network: 'TRC20' }), fakeProbe({ ETH: [a] }));
    expect(entries[0].chain).toBe('ETH');
    expect(warnings.map((w) => w.code)).toContain('NETWORK_MISMATCH');
  });

  it('probes a shared address once per batch (memoised)', async () => {
    const a = evm('seven');
    const p = fakeProbe({ ETH: [a] });
    const runner = createProbeRunner(p.probe);
    await Promise.all([resolveEntries(norm({ addresses: [a], network: undefined }), runner), resolveEntries(norm({ ackNo: 'ACK-R2', addresses: [a], network: undefined }), runner)]);
    expect(p.calls.filter((c) => c.startsWith('addr:ETH')).length).toBe(1);
  });
});

describe('transaction hashes', () => {
  it('tries TRON first, then Bitcoin, for a bare 64-hex hash', async () => {
    const h = txHash('t1');
    const onTron = await run(norm({ addresses: [], txHashes: [h], network: undefined }), fakeProbe({ TRON: [h] }));
    expect(onTron.entries[0].chain).toBe('TRON');
    expect(onTron.calls).toEqual([`tx:TRON:${h}`]);

    const onBtc = await run(norm({ addresses: [], txHashes: [h], network: undefined }), fakeProbe({ BTC: [h] }));
    expect(onBtc.entries[0].chain).toBe('BTC');
    expect(onBtc.calls).toEqual([`tx:TRON:${h}`, `tx:BTC:${h}`]);
  });

  it('leaves an unfound hash unverified with TRON-first candidates, never a seed', async () => {
    const h = txHash('t2');
    const { entries } = await run(norm({ addresses: [], txHashes: [h], network: undefined }));
    expect(entries[0]).toMatchObject({ chain: null, candidateChains: ['TRON', 'BTC'], flags: ['UNVERIFIED_TX'] });
    expect(seedChainsOf(entries[0])).toEqual([]);
  });

  it('a TRC20 complaint decides the chain of a bare hash without probing', async () => {
    const { entries, calls } = await run(norm({ addresses: [], txHashes: [txHash('t3')], network: 'TRC20' }));
    expect(entries[0].chain).toBe('TRON');
    expect(calls).toEqual([]);
  });

  it('resolves an 0x transaction hash by probing the EVM chains', async () => {
    const h = `0x${txHash('t4')}`;
    const { entries } = await run(norm({ addresses: [], txHashes: [h], network: undefined }), fakeProbe({ POLYGON: [h] }));
    expect(entries[0].chain).toBe('POLYGON');
  });
});

describe('fake-token guard', () => {
  it('accepts the official USDT-TRC20 contract without warnings', async () => {
    const { warnings, entries } = await run(norm({ tokenContract: USDT_TRC20 }));
    expect(warnings).toEqual([]);
    expect(entries[0].flags).toEqual([]);
  });

  it('flags a look-alike TRON token and marks every address', async () => {
    const { warnings, entries } = await run(norm({ tokenContract: 'TKX4tuVb4ApiutoibSFugfFW9nBcXaMNDe', addresses: [tronAddress('a'), tronAddress('b')] }));
    expect(warnings.map((w) => w.code)).toEqual(['UNTRUSTED_TOKEN']);
    expect(warnings[0].message).toMatch(/look-alike/);
    expect(entries.every((e) => e.flags.includes('UNTRUSTED_TOKEN'))).toBe(true);
  });

  it('flags an official contract that belongs to a different chain', async () => {
    const { warnings } = await run(norm({ tokenContract: USDT_ERC20 })); // TRON address + ERC20 USDT
    expect(warnings.map((w) => w.code)).toEqual(['UNTRUSTED_TOKEN']);
  });

  it('trusts the ERC-20 USDT contract for an ERC20 complaint (case-insensitive)', async () => {
    const { warnings } = await run(norm({ addresses: [evmAddress('tok')], network: 'ERC20', tokenContract: USDT_ERC20.toLowerCase() }));
    expect(warnings).toEqual([]);
  });

  it('flags a malformed token contract', async () => {
    const { warnings } = await run(norm({ tokenContract: 'USDT' }));
    expect(warnings[0]).toMatchObject({ code: 'UNTRUSTED_TOKEN' });
    expect(warnings[0].message).toMatch(/not a valid contract/);
  });
});

describe('probe runner', () => {
  it('turns a slow probe into unknown instead of stalling', async () => {
    const slow = { addressActive: () => new Promise<boolean>(() => undefined), txExists: async () => false };
    const runner = createProbeRunner(slow, { timeoutMs: 30 });
    expect(await runner.address('ETH', '0xabc')).toBe('unknown');
  });

  it('caps concurrent probes', async () => {
    let running = 0;
    let peak = 0;
    const probe = {
      addressActive: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return false;
      },
      txExists: async () => false,
    };
    const runner = createProbeRunner(probe, { concurrency: 3 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => runner.address('ETH', `a${i}`)));
    expect(peak).toBeLessThanOrEqual(3);
  });
});
