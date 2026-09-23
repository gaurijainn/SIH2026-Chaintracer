import type { PrismaClient } from '@prisma/client';
import { classifyIdentifier, type Chain } from '@ps26183/shared';
import type { AuditService } from '../audit/service';
import { upsertLabel } from '../attribution/labelStore';

export class InvalidLabelAddressError extends Error {
  constructor(raw: string, readonly reasons: string[]) {
    super(`not a recognised address: ${raw}`);
  }
}
export class LabelNotFoundError extends Error {
  constructor(id: string) {
    super(`label not found: ${id}`);
  }
}
export class VaspNotFoundError extends Error {
  constructor(id: string) {
    super(`vasp not found: ${id}`);
  }
}
/** Imported labels (eth-labels, tronscan, ofac, chainabuse) belong to their loaders; only manual ones are editable here. */
export class LabelNotManualError extends Error {
  constructor(id: string, source: string) {
    super(`label ${id} comes from source "${source}" and can only be changed by re-importing that source`);
  }
}

export interface ManualLabelInput {
  chain: Chain;
  addr: string;
  name: string;
  category: string;
  confidence?: number;
  evidence?: unknown;
  vaspId?: string;
}

export const MANUAL_SOURCE = 'manual';
export const DEFAULT_MANUAL_CONFIDENCE = 0.8;

/** Manual (investigator/admin) label writes, each recorded in the hash-chained audit log with the actor and the before/after. */
export class LabelAdminService {
  constructor(private readonly deps: { prisma: PrismaClient; audit: AuditService }) {}

  async upsertManual(input: ManualLabelInput, actorId: string) {
    const c = classifyIdentifier(input.addr);
    if (c.kind !== 'ADDRESS') throw new InvalidLabelAddressError(input.addr, c.kind === 'INVALID' ? c.reasons : [`identifier is a ${c.kind}, not an address`]);
    if (input.vaspId && !(await this.deps.prisma.vasp.findUnique({ where: { id: input.vaspId }, select: { id: true } }))) throw new VaspNotFoundError(input.vaspId);

    const { prisma } = this.deps;
    const key = { chain: input.chain, addr: c.normalized, source: MANUAL_SOURCE, name: input.name };
    const before = await prisma.label.findUnique({ where: { chain_addr_source_name: key } });
    await upsertLabel(prisma as never, {
      chain: input.chain,
      addr: c.normalized,
      name: input.name,
      category: input.category,
      source: MANUAL_SOURCE,
      confidence: input.confidence ?? DEFAULT_MANUAL_CONFIDENCE,
      evidence: input.evidence,
      vaspId: input.vaspId,
    } as never);
    const label = await prisma.label.findUniqueOrThrow({ where: { chain_addr_source_name: key } });

    await this.deps.audit.record({
      actorId,
      action: before ? 'label updated' : 'label created',
      entity: 'Label',
      entityId: label.id,
      meta: {
        chain: label.chain,
        addr: label.addr,
        name: label.name,
        category: label.category,
        confidence: label.confidence.toString(),
        ...(before ? { previous: { category: before.category, confidence: before.confidence.toString(), vaspId: before.vaspId } } : {}),
      },
    });
    return label;
  }

  async remove(id: string, actorId: string) {
    const { prisma } = this.deps;
    const label = await prisma.label.findUnique({ where: { id } });
    if (!label) throw new LabelNotFoundError(id);
    if (label.source !== MANUAL_SOURCE) throw new LabelNotManualError(id, label.source);
    await prisma.label.delete({ where: { id } });
    await this.deps.audit.record({
      actorId,
      action: 'label deleted',
      entity: 'Label',
      entityId: id,
      meta: { chain: label.chain, addr: label.addr, name: label.name, category: label.category, confidence: label.confidence.toString() },
    });
  }
}
