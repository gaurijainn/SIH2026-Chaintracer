import type { PrismaClient } from '@prisma/client';
import type { AuditService } from '../audit/service';
import { upsertVasp, type VaspSeed } from '../attribution/vaspRegistry';

/** VASP registry reads and Admin edits (plan: "GET / POST /vasps -- VASP registry (Admin can edit)"). */
export class VaspService {
  constructor(private readonly deps: { prisma: PrismaClient; audit: AuditService }) {}

  list() {
    return this.deps.prisma.vasp.findMany({ include: { addresses: true }, orderBy: { name: 'asc' } });
  }

  async upsert(seed: VaspSeed, actorId: string) {
    const { prisma } = this.deps;
    const existed = await prisma.vasp.findUnique({ where: { name: seed.name }, select: { id: true } });
    const id = await upsertVasp(prisma as never, seed);
    await this.deps.audit.record({
      actorId,
      action: existed ? 'vasp updated' : 'vasp created',
      entity: 'Vasp',
      entityId: id,
      meta: { name: seed.name, type: seed.type, fiuStatus: seed.fiuStatus, hotWallets: (seed.hotWallets ?? []).map((w) => `${w.chain}:${w.addr}`) },
    });
    return prisma.vasp.findUniqueOrThrow({ where: { id }, include: { addresses: true } });
  }
}
