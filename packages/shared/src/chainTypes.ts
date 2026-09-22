import { address as btcAddress } from 'bitcoinjs-lib';
import { getAddress } from 'ethers';
import type { Chain } from './constants';

/**
 * Normalised provider output (plan B3). Every adapter returns exactly these shapes, whatever the
 * upstream API looked like, so tracing (B4) never sees provider-specific data.
 *
 *  - amount is a decimal string in whole token units (never a float)
 *  - ts is epoch MILLISECONDS (UTC)
 *  - token is the official contract address, or the native asset symbol (TRX, ETH, POL, BNB, BTC)
 *  - (txHash, idx) is unique per transfer; idx bands keep native, token and internal transfers of one tx apart
 *  - block is 0 where the provider does not report it (TronGrid TRC-20 history)
 */
export interface Transfer {
  chain: Chain;
  txHash: string;
  idx: number;
  from: string;
  to: string;
  token: string;
  amount: string;
  usd?: number;
  ts: number;
  block: number;
}

export interface AccountMeta {
  chain: Chain;
  addr: string;
  /** on-chain account creation, epoch ms; null when the providers cannot tell */
  createdAt: number | null;
  /** TRON: wallet whose earliest inbound transfer activated the account */
  activator: string | null;
  publicTag: string | null;
  /** security flags with a stable vocabulary; see TRON_FLAG_KEYS */
  flags: Record<string, boolean | null>;
  /** providers that contributed to this record */
  sources: string[];
  /** parts that could not be fetched (provider down); the rest is still valid */
  partial?: string[];
  fetchedAt: number;
}

export interface GetTransfersOpts {
  /** only transfers at or after this time, epoch ms */
  since?: number;
  /** opaque cursor from a previous page */
  cursor?: string;
}

export interface TransferPage {
  items: Transfer[];
  next?: string;
}

export interface ChainAdapter {
  getTransfers(addr: string, dir: 'in' | 'out', o?: GetTransfersOpts): Promise<TransferPage>;
  getAccountMeta(addr: string): Promise<AccountMeta>;
}

/** Cheap existence checks used by complaint intake (B2) to disambiguate chains. */
export interface ProbeCapable {
  hasActivity(addr: string): Promise<boolean>;
  txExists(hash: string): Promise<boolean>;
}

export const NATIVE_SYMBOL: Record<Chain, string> = { TRON: 'TRX', ETH: 'ETH', POLYGON: 'POL', BSC: 'BNB', BTC: 'BTC' };

/** idx bands: one transaction can hold a native transfer, many token transfers and internal traces. */
export const IDX_NATIVE = 0;
export const IDX_TOKEN_BASE = 1;
export const IDX_INTERNAL_BASE = 1_000_000;

/** Keys used in AccountMeta.flags for TRON (Tronscan Security Service). */
export const TRON_FLAG_KEYS = ['fraudTransaction', 'fraudTokenCreator', 'stablecoinBlacklist', 'sendAdByMemo'] as const;

/** Exact decimal formatting of an integer amount: formatUnits('1500000', 6) === '1.5'. No floats involved. */
export function formatUnits(value: string | bigint, decimals: number): string {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** TRON hex address (41...) as returned by full-node style endpoints -> Base58Check T... */
export function tronHexToBase58(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (!/^41[0-9a-fA-F]{40}$/.test(clean)) throw new Error(`not a TRON hex address: ${hex}`);
  return btcAddress.toBase58Check(Buffer.from(clean.slice(2), 'hex'), 0x41);
}

/**
 * Gives transfers of one transaction a stable idx: their rank after sorting by (from, to, amount, token),
 * offset by the band base. Providers that report no log index (Etherscan tokentx, TronGrid) get
 * deterministic values, so re-reading the same history yields the same (txHash, idx) keys.
 */
export function assignIdx<T extends Omit<Transfer, 'idx'>>(items: T[], base: number): (T & { idx: number })[] {
  const byTx = new Map<string, T[]>();
  for (const it of items) byTx.set(it.txHash, [...(byTx.get(it.txHash) ?? []), it]);
  const idxOf = new Map<T, number>();
  for (const group of byTx.values()) {
    const key = (t: T) => [t.from, t.to, t.amount, t.token].join('|');
    [...group].sort((a, b) => key(a).localeCompare(key(b))).forEach((it, rank) => idxOf.set(it, base + rank));
  }
  return items.map((it) => ({ ...it, idx: idxOf.get(it)! })); // provider ordering preserved
}

/** EIP-55 form of an EVM address (providers return lower, upper or mixed case). */
export function evmChecksum(addr: string): string {
  return getAddress(addr.toLowerCase());
}
