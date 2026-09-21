import { FAMILY_CHAINS, classifyIdentifier, isTrustedToken, type Chain } from '@ps26183/shared';
import type { ProbeRunner } from './probe';
import type { Issue, NormalizedComplaint, NormalizedEntry, Network, ResolvedEntry } from './types';

const NETWORK_CHAIN: Record<Network, Chain> = { TRC20: 'TRON', ERC20: 'ETH', BEP20: 'BSC' };
const EVM_CHAINS = FAMILY_CHAINS.EVM;

const resolved = (e: NormalizedEntry, chain: Chain | null, candidateChains: Chain[] = [], flags: string[] = []): ResolvedEntry => ({
  ...e,
  chain,
  candidateChains,
  flags,
});

async function resolveEvmAddress(e: NormalizedEntry, network: Network | undefined, probe: ProbeRunner, warnings: Issue[]) {
  if (network === 'ERC20' || network === 'BEP20') return resolved(e, NETWORK_CHAIN[network]); // victim's network wins, no probing
  if (network === 'TRC20') {
    warnings.push({ field: 'network', code: 'NETWORK_MISMATCH', message: `${e.value} is an EVM address but the complaint says TRC20; probing ETH, BSC and Polygon` });
  }
  // ambiguity: one 0x address is valid on ETH, BSC and Polygon, so probe all three in parallel
  const status = await Promise.all(EVM_CHAINS.map((c) => probe.address(c, e.value)));
  const active = EVM_CHAINS.filter((_, i) => status[i] === 'active');
  const unknown = EVM_CHAINS.filter((_, i) => status[i] === 'unknown');

  if (active.length === 1) return resolved(e, active[0], [], ['CHAIN_PROBED']);
  if (active.length > 1) return resolved(e, null, active, ['AMBIGUOUS_CHAIN']);
  if (unknown.length) return resolved(e, null, unknown, unknown.length > 1 ? ['AMBIGUOUS_CHAIN', 'PROBE_UNAVAILABLE'] : ['PROBE_UNAVAILABLE']);
  return resolved(e, null, [...EVM_CHAINS], ['NO_ACTIVITY']);
}

async function resolveTxHash(e: NormalizedEntry, network: Network | undefined, probe: ProbeRunner) {
  if (e.family === 'EVM') {
    if (network === 'ERC20' || network === 'BEP20') return resolved(e, NETWORK_CHAIN[network]);
    const status = await Promise.all(EVM_CHAINS.map((c) => probe.tx(c, e.value)));
    const found = EVM_CHAINS.filter((_, i) => status[i] === 'active');
    if (found.length === 1) return resolved(e, found[0]);
    return resolved(e, null, found.length ? found : [...EVM_CHAINS], ['UNVERIFIED_TX']);
  }
  // 64-hex hash: same shape on TRON and Bitcoin, so try TRON first, then Bitcoin
  if (network === 'TRC20') return resolved(e, 'TRON');
  if ((await probe.tx('TRON', e.value)) === 'active') return resolved(e, 'TRON');
  if ((await probe.tx('BTC', e.value)) === 'active') return resolved(e, 'BTC');
  return resolved(e, null, ['TRON', 'BTC'], ['UNVERIFIED_TX']);
}

/**
 * Assigns chains to every address / hash of a complaint.
 * TRON and Bitcoin are decided by format alone (TRON fast path: no probing). Only ambiguous EVM
 * addresses and 64-hex hashes touch the network, and only when the victim's network field does not decide.
 */
export async function resolveEntries(c: NormalizedComplaint, probe: ProbeRunner): Promise<{ entries: ResolvedEntry[]; warnings: Issue[] }> {
  const warnings: Issue[] = [];
  const out: ResolvedEntry[] = await Promise.all(
    c.entries.map(async (e): Promise<ResolvedEntry> => {
      if (e.kind === 'TX_HASH') return resolveTxHash(e, c.network, probe);
      if (e.family === 'TRON' || e.family === 'BTC') {
        const own: Network | undefined = e.family === 'TRON' ? 'TRC20' : undefined;
        if (c.network && c.network !== own) {
          warnings.push({ field: 'network', code: 'NETWORK_MISMATCH', message: `${e.value} is a ${e.family} address but the complaint says ${c.network}; address format wins` });
        }
        return resolved(e, e.family === 'TRON' ? 'TRON' : 'BTC');
      }
      return resolveEvmAddress(e, c.network, probe, warnings);
    }),
  );

  // fake-token guard: only official stablecoin contracts are trusted; the trace always uses the official one
  if (c.tokenContract) {
    const cls = classifyIdentifier(c.tokenContract);
    const chains = new Set<Chain>(c.network ? [NETWORK_CHAIN[c.network]] : []);
    for (const e of out) for (const ch of e.chain ? [e.chain] : e.candidateChains) if (e.kind === 'ADDRESS') chains.add(ch);
    const trusted = cls.kind === 'ADDRESS' && [...chains].some((ch) => isTrustedToken(ch, cls.normalized));
    if (!trusted) {
      warnings.push({
        field: 'tokenContract',
        code: 'UNTRUSTED_TOKEN',
        message:
          cls.kind === 'ADDRESS'
            ? `${cls.normalized} is not an official stablecoin contract on ${[...chains].join('/') || 'the resolved chain'}; ignored, tracing the official USDT only (possible look-alike token)`
            : `token contract "${c.tokenContract}" is not a valid contract address; ignored`,
      });
      for (const e of out) if (e.kind === 'ADDRESS') e.flags.push('UNTRUSTED_TOKEN');
    }
  }
  for (const e of out) {
    if (e.candidateChains.length > 1 || e.flags.includes('NO_ACTIVITY') || e.flags.includes('PROBE_UNAVAILABLE')) {
      warnings.push({
        field: e.value,
        code: e.flags.includes('NO_ACTIVITY') ? 'NO_ACTIVITY' : e.flags.includes('PROBE_UNAVAILABLE') ? 'PROBE_UNAVAILABLE' : e.kind === 'TX_HASH' ? 'UNVERIFIED_TX' : 'AMBIGUOUS_CHAIN',
        message: `${e.value}: candidate chains ${e.candidateChains.join(', ')}${e.flags.includes('NO_ACTIVITY') ? ' (no activity found on any); not queued for tracing' : ''}`,
      });
    }
  }
  return { entries: out, warnings };
}
