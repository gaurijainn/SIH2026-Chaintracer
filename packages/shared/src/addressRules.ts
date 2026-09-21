import { address as btcAddress } from 'bitcoinjs-lib';
import { getAddress, isAddress } from 'ethers';
import type { Chain } from './constants';

/**
 * Address and hash rules (plan Appendix A). Detection order is TRON, then EVM, then Bitcoin.
 * Normalisation never "repairs" a Base58 string: characters outside the alphabet are reported.
 */

export const RULES = {
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  evm: /^0x[a-fA-F0-9]{40}$/,
  btcLegacy: /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  btcBech32: /^bc1[ac-hj-np-z02-9]{11,71}$/,
  evmTx: /^0x[a-fA-F0-9]{64}$/,
  hex64: /^[a-fA-F0-9]{64}$/,
} as const;

export type AddressFamily = 'TRON' | 'EVM' | 'BTC';

/** Chains an address of a given family can live on, in probe order. */
export const FAMILY_CHAINS: Record<AddressFamily, Chain[]> = {
  TRON: ['TRON'],
  EVM: ['ETH', 'BSC', 'POLYGON'],
  BTC: ['BTC'],
};

export type Classified =
  | { kind: 'ADDRESS'; family: AddressFamily; normalized: string }
  | { kind: 'TX_HASH'; family: 'EVM' | 'TRON_OR_BTC'; normalized: string }
  | { kind: 'INVALID'; normalized: string; reasons: string[] };

// zero-width space/non-joiner/joiner, word joiner, BOM, soft hyphen, bidi marks
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E]/g;

/** trim, strip zero-width characters and every kind of whitespace, fix a leading 0X to 0x. */
export function normalizeIdentifier(raw: string): string {
  const s = raw.replace(ZERO_WIDTH, '').replace(/\s+/g, '');
  return /^0X/.test(s) ? `0x${s.slice(2)}` : s;
}

function tronChecksumOk(addr: string): boolean {
  try {
    const { version, hash } = btcAddress.fromBase58Check(addr);
    return version === 0x41 && hash.length === 20;
  } catch {
    return false;
  }
}

function btcOk(addr: string): boolean {
  try {
    if (addr.startsWith('bc1')) {
      const d = btcAddress.fromBech32(addr);
      if (d.prefix !== 'bc') return false;
      return d.version === 0 ? d.data.length === 20 || d.data.length === 32 : d.version === 1 && d.data.length === 32;
    }
    const { version } = btcAddress.fromBase58Check(addr);
    return version === 0x00 || version === 0x05; // P2PKH / P2SH
  } catch {
    return false;
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

function diagnose(s: string): string[] {
  const reasons: string[] = [];
  if (s === '') return ['empty value'];
  if (/^0x/.test(s)) {
    const hex = s.slice(2);
    if (!/^[a-fA-F0-9]*$/.test(hex)) reasons.push('0x value contains non-hex characters');
    else if (hex.length === 40) reasons.push('EIP-55 checksum mismatch (mixed-case letters do not match the checksum)');
    else if (hex.length === 64) reasons.push('unexpected transaction hash format');
    else reasons.push(`0x value has ${hex.length} hex characters; an address has 40 and a transaction hash 64`);
    return reasons;
  }
  if (s[0] === 'T') {
    if (s.length !== 34) reasons.push(`TRON address must be 34 characters, got ${s.length}`);
    const bad = [...s].filter((c) => !BASE58.test(c));
    if (bad.length) {
      reasons.push(
        `contains characters outside the Base58 alphabet (${[...new Set(bad)].join(' ')}); 0, O, I and l are never valid. Not auto-corrected: check the original`,
      );
    } else if (s.length === 34) reasons.push('Base58Check checksum failed (likely a typo)');
    return reasons;
  }
  if (/^(bc1|BC1)/.test(s)) return ['invalid bech32 address (bad checksum, length or mixed case)'];
  if (/^[13]/.test(s)) {
    const bad = [...s].filter((c) => !BASE58.test(c));
    if (bad.length) reasons.push(`contains characters outside the Base58 alphabet (${[...new Set(bad)].join(' ')}); not auto-corrected`);
    else reasons.push('Bitcoin Base58Check checksum or length invalid');
    return reasons;
  }
  if (/^[a-fA-F0-9]+$/.test(s) && s.length !== 64) reasons.push(`hex value of length ${s.length}; a transaction hash has 64`);
  else reasons.push('not a recognised TRON, EVM or Bitcoin address or transaction hash');
  return reasons;
}

/** Classify one identifier from a complaint. Order: TRON, EVM, Bitcoin, then transaction hashes. */
export function classifyIdentifier(raw: string): Classified {
  let s = normalizeIdentifier(raw);

  if (RULES.tron.test(s) && tronChecksumOk(s)) return { kind: 'ADDRESS', family: 'TRON', normalized: s };

  if (RULES.evm.test(s) && isAddress(s)) return { kind: 'ADDRESS', family: 'EVM', normalized: getAddress(s.toLowerCase()) };

  if (RULES.evmTx.test(s)) return { kind: 'TX_HASH', family: 'EVM', normalized: s.toLowerCase() };

  // bech32 must be all lower or all upper; an all-upper string is normalised to lower (spec-legal, not a repair)
  if (/^BC1/.test(s) && s === s.toUpperCase()) s = s.toLowerCase();
  if ((RULES.btcBech32.test(s) || RULES.btcLegacy.test(s)) && btcOk(s)) return { kind: 'ADDRESS', family: 'BTC', normalized: s };

  // TRON or BTC transaction hash: same 64-hex shape on both, resolved later (TRON first)
  if (RULES.hex64.test(s)) return { kind: 'TX_HASH', family: 'TRON_OR_BTC', normalized: s.toLowerCase() };

  return { kind: 'INVALID', normalized: s, reasons: diagnose(s) };
}
