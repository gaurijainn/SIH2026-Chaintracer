import type { Chain } from '@ps26183/shared';
import type { RuleContext, StateRuleContext } from './rules';

/** The exact subset of PrismaClient the real B8 rule-context lookups need. */
export interface RuleContextPrisma {
  label: {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ name: string; category: string } | null>;
  };
  sharedMuleFlag: {
    findUnique(args: { where: { chain_addr: { chain: string; addr: string } } }): Promise<{ caseCount: number; caseIds: string[] } | null>;
  };
  addressProfile: {
    findUnique(args: { where: { chain_addr: { chain: string; addr: string } } }): Promise<{ flags: unknown } | null>;
  };
  alert: {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
}

/**
 * Real implementations of RuleContext/StateRuleContext over Prisma, reusing existing B4/B5/B6 read
 * patterns exactly (see workers/trace/engine.ts's own Label lookup for the stop-condition query this
 * mirrors, and apps/api/src/mule/analyzeCase.ts's SharedMuleFlag) -- no detection logic is
 * reimplemented here, only read queries over data those systems already produce.
 */
export function buildRuleContext(prisma: RuleContextPrisma): RuleContext {
  return {
    findVasp: async (chain, addr) => {
      const label = await prisma.label.findFirst({ where: { chain, addr, category: 'exchange' } });
      return label ? { name: label.name } : null;
    },
    findObfuscation: async (chain, addr) => {
      const label = await prisma.label.findFirst({ where: { chain, addr, category: { in: ['mixer', 'bridge'] } } });
      if (!label) return null;
      const category = label.category === 'mixer' ? 'mixer' : 'bridge';
      return { category, name: label.name };
    },
  };
}

export function buildStateRuleContext(prisma: RuleContextPrisma): StateRuleContext {
  return {
    getSharedMule: async (chain, addr) => {
      const flag = await prisma.sharedMuleFlag.findUnique({ where: { chain_addr: { chain, addr } } });
      return flag ? { caseCount: flag.caseCount, caseIds: flag.caseIds } : null;
    },
    getBlacklistState: async (chain, addr) => {
      const [sanctionLabel, profile] = await Promise.all([
        prisma.label.findFirst({ where: { chain, addr, category: 'sanctioned' } }),
        prisma.addressProfile.findUnique({ where: { chain_addr: { chain, addr } } }),
      ]);
      const flags = (profile?.flags as Record<string, unknown> | null) ?? null;
      return { sanctioned: !!sanctionLabel, stablecoinBlacklisted: flags?.stablecoinBlacklist === true };
    },
    a5AlreadyFired: async (chain, addr) => !!(await prisma.alert.findFirst({ where: { chain, address: addr, rule: 'A5_BLACKLIST' } })),
    a4AlreadyFired: async (chain, addr) => !!(await prisma.alert.findFirst({ where: { chain, address: addr, rule: 'A4_LINKAGE' } })),
  };
}

export type { Chain };
