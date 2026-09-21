import { USDT_TRC20 } from './constants';

/**
 * Synthetic sample case used by the B1 seed and tests. Addresses are checksum-valid TRON
 * addresses derived from fixed labels; no real victim data.
 * Flow: victim -> mule1 -> mule2 -> exchange deposit address -> exchange hot wallet.
 */
export const SAMPLE = {
  ackNo: 'SAMPLE-2026-0001',
  reportedAt: '2026-09-01T08:30:00.000Z',
  category: 'Investment fraud',
  amountInr: '500000.00',
  network: 'TRC20',
  addr: {
    victim: 'THV3PRcWHSbGnHA1PmcsEbqEzgVX6DJnDG',
    mule1: 'TQzQZGrZNw3Ni27hRyCj6pjrKm9u2jkZ8M',
    mule2: 'TAsspXacEqxsGAo8zbxwhJrZ7Jmhj9C33U',
    deposit: 'TNDTnLegqXPSdQ2rACp6euQKNDvsnDmXCA',
    hotWallet: 'TTkFHA8GB7wi77KgnZ7V6LUkuk93UKV9FR',
  },
  vasp: { name: 'Demo Exchange (synthetic)', jurisdiction: 'Demo', fiuStatus: 'REGISTERED' },
  token: USDT_TRC20,
} as const;

const h = (n: number) => n.toString(16).padStart(64, '0');

export interface SampleHop {
  hopNo: number;
  txHash: string;
  idx: number;
  from: string;
  to: string;
  amount: string;
  usd: string;
  ts: string;
}

const a = SAMPLE.addr;
export const SAMPLE_HOPS: SampleHop[] = [
  { hopNo: 0, txHash: h(1), idx: 0, from: a.victim, to: a.mule1, amount: '5700.000000', usd: '5700.000000', ts: '2026-09-01T08:10:00.000Z' },
  { hopNo: 1, txHash: h(2), idx: 0, from: a.mule1, to: a.mule2, amount: '5690.500000', usd: '5690.500000', ts: '2026-09-01T08:42:00.000Z' },
  { hopNo: 2, txHash: h(3), idx: 0, from: a.mule2, to: a.deposit, amount: '5680.250000', usd: '5680.250000', ts: '2026-09-01T09:05:00.000Z' },
  { hopNo: 3, txHash: h(4), idx: 0, from: a.deposit, to: a.hotWallet, amount: '5680.250000', usd: '5680.250000', ts: '2026-09-01T09:20:00.000Z' },
];
