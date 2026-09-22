import type { Chain } from '@ps26183/shared';

/**
 * Small, curated lists of well-known DEX router/pool and cross-chain bridge contract addresses.
 * Not exhaustive — B4's "Done when" only requires that a swap or bridge hop through one of these
 * is recognised and handled specially; unknown routers/bridges are traced as ordinary counterparties.
 * TRON addresses are Base58 (case-sensitive); EVM addresses are compared case-insensitively.
 */
export const DEX_ROUTERS: Partial<Record<Chain, string[]>> = {
  TRON: [
    'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', // SunSwap V2 router
    'TFP9S5PgVpuNjEQdXHbNSyzP2wRJNikkmT', // SunSwap V1 router
  ],
  ETH: [
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 router
    '0xe592427a0aece92de3edee1f18e0157c05861564', // Uniswap V3 router
  ],
  BSC: [
    '0x10ed43c718714eb63d5aa57b78b54704e256024e', // PancakeSwap V2 router
  ],
  POLYGON: [
    '0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff', // QuickSwap router
  ],
};

/** Cross-chain bridge deposit contracts (source-chain side). Continuing on the destination chain needs a resolver. */
export const BRIDGE_CONTRACTS: Partial<Record<Chain, string[]>> = {
  TRON: [
    'TXHFHPMe5FXCzdKjWLQyq8Q8SFyLdmA9tG', // illustrative TRON-side bridge deposit contract (demo/fixture use)
  ],
  ETH: [
    '0x8731d54e9d02c286767d56ac03e8037c07e01e98', // illustrative multi-chain bridge router (demo/fixture use)
  ],
  BSC: [],
  POLYGON: [],
};

const norm = (chain: Chain, addr: string) => (chain === 'TRON' ? addr : addr.toLowerCase());

export function isKnownContract(list: Partial<Record<Chain, string[]>>, chain: Chain, addr: string): boolean {
  return (list[chain] ?? []).some((c) => norm(chain, c) === norm(chain, addr));
}

export const isDexRouter = (chain: Chain, addr: string): boolean => isKnownContract(DEX_ROUTERS, chain, addr);
export const isBridgeContract = (chain: Chain, addr: string): boolean => isKnownContract(BRIDGE_CONTRACTS, chain, addr);
