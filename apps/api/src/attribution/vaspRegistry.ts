import type { Chain } from '@ps26183/shared';

export interface VaspHotWalletSeed {
  chain: Chain;
  addr: string;
  source: string;
  confidence: number;
}

export interface VaspSeed {
  name: string;
  type: 'CENTRALISED_EXCHANGE' | 'INSTANT_SWAP' | 'OTC' | 'P2P';
  jurisdiction: string;
  fiuStatus: string;
  fiuStatusDate?: string; // ISO date
  fiuSource?: string;
  contactEmail?: string;
  contactPortal?: string;
  hotWallets?: VaspHotWalletSeed[];
}

/**
 * Real, publicly-stated facts only (plan Section 1: FIU-IND noticed 15 VDA service providers on
 * 9 September 2026, three of them instant-swap no-account exit routes). No hot wallets are seeded
 * for these because we have not independently verified any address as belonging to them; an
 * investigator adds those once confirmed. Real centralised exchanges are deliberately left out of
 * this seed rather than guessing at unverified hot-wallet addresses — see the B5 report for why.
 *
 * To add a verified VASP hot wallet later (no code change needed): call upsertVasp with a VaspSeed
 * whose `hotWallets` lists the confirmed {chain, addr, source, confidence}, or extend this array and
 * pass it to loadVaspRegistrySeed. upsertVasp is idempotent on both the VASP name and each wallet's
 * (chain, addr), so re-running with more wallets added is always safe.
 */
export const FIU_IND_INSTANT_SWAP_SEED: VaspSeed[] = [
  {
    name: 'ChangeNow',
    type: 'INSTANT_SWAP',
    jurisdiction: 'Offshore (non-KYC instant-swap service)',
    fiuStatus: 'NOTICED',
    fiuStatusDate: '2026-09-09',
    fiuSource: 'FIU-IND / PIB release, 9 September 2026',
  },
  {
    name: 'SimpleSwap',
    type: 'INSTANT_SWAP',
    jurisdiction: 'Offshore (non-KYC instant-swap service)',
    fiuStatus: 'NOTICED',
    fiuStatusDate: '2026-09-09',
    fiuSource: 'FIU-IND / PIB release, 9 September 2026',
  },
  {
    name: 'FixedFloat',
    type: 'INSTANT_SWAP',
    jurisdiction: 'Offshore (non-KYC instant-swap service)',
    fiuStatus: 'NOTICED',
    fiuStatusDate: '2026-09-09',
    fiuSource: 'FIU-IND / PIB release, 9 September 2026',
  },
];

/** The exact subset of PrismaClient the VASP registry loader needs. */
export interface VaspPrisma {
  vasp: {
    upsert(args: { where: { name: string }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<{ id: string }>;
  };
  vaspAddress: {
    upsert(args: {
      where: { chain_addr: { chain: string; addr: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/** Idempotent: upserts by Vasp.name and VaspAddress's (chain, addr) unique key. */
export async function upsertVasp(prisma: VaspPrisma, seed: VaspSeed): Promise<string> {
  const data = {
    type: seed.type,
    jurisdiction: seed.jurisdiction,
    fiuStatus: seed.fiuStatus,
    fiuStatusDate: seed.fiuStatusDate ? new Date(seed.fiuStatusDate) : null,
    fiuSource: seed.fiuSource ?? null,
    contactEmail: seed.contactEmail ?? null,
    contactPortal: seed.contactPortal ?? null,
  };
  const vasp = await prisma.vasp.upsert({ where: { name: seed.name }, create: { name: seed.name, ...data }, update: data });
  for (const w of seed.hotWallets ?? []) {
    await prisma.vaspAddress.upsert({
      where: { chain_addr: { chain: w.chain, addr: w.addr } },
      create: { vaspId: vasp.id, chain: w.chain, addr: w.addr, kind: 'HOT_WALLET', source: w.source, confidence: w.confidence },
      update: { vaspId: vasp.id, kind: 'HOT_WALLET', source: w.source, confidence: w.confidence },
    });
  }
  return vasp.id;
}

export async function loadVaspRegistrySeed(prisma: VaspPrisma, seed: VaspSeed[] = FIU_IND_INSTANT_SWAP_SEED): Promise<number> {
  for (const s of seed) await upsertVasp(prisma, s);
  return seed.length;
}
