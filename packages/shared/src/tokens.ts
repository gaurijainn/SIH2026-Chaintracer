import { USDT_TRC20, type Chain } from './constants';

/**
 * Fake-token guard (B2). Only these official stablecoin contracts are ever traced; TRON is full of
 * look-alike "USDT" tokens used in address poisoning, so anything else is flagged, never trusted.
 */
export interface TrustedToken {
  chain: Chain;
  symbol: string;
  standard: 'TRC20' | 'ERC20' | 'BEP20';
  contract: string;
}

export const USDT_ERC20 = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const BSC_USD = '0x55d398326f99059fF775485246999027B3197955';

export const TOKEN_WHITELIST: readonly TrustedToken[] = [
  { chain: 'TRON', symbol: 'USDT', standard: 'TRC20', contract: USDT_TRC20 },
  { chain: 'ETH', symbol: 'USDT', standard: 'ERC20', contract: USDT_ERC20 },
  { chain: 'BSC', symbol: 'BSC-USD', standard: 'BEP20', contract: BSC_USD },
];

const same = (chain: Chain, a: string, b: string) =>
  chain === 'TRON' ? a === b : a.toLowerCase() === b.toLowerCase(); // TRON Base58 is case-sensitive

export function trustedTokenFor(chain: Chain): TrustedToken | undefined {
  return TOKEN_WHITELIST.find((t) => t.chain === chain);
}

/** Official stablecoin contract pre-selected for a chain's trace, or null when none is whitelisted. */
export function defaultTokenContract(chain: Chain): string | null {
  return trustedTokenFor(chain)?.contract ?? null;
}

export function isTrustedToken(chain: Chain, contract: string): boolean {
  const t = trustedTokenFor(chain);
  return !!t && same(chain, t.contract, contract);
}
