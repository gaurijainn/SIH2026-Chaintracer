import { describe, expect, it, vi } from 'vitest';
import { persistAndPublishAlert, type AlertPersistPrisma } from './alerts';

const baseInput = {
  caseId: 'case1',
  rule: 'A1_MOVEMENT' as const,
  severity: 'HIGH' as const,
  chain: 'TRON' as const,
  address: 'Taddr',
  amount: '100',
  message: 'test',
};

describe('persistAndPublishAlert', () => {
  it('persists first, then publishes, in that order', async () => {
    const order: string[] = [];
    const prisma: AlertPersistPrisma = {
      alert: {
        create: async () => {
          order.push('persist');
          return { id: 'a1', caseId: 'case1', rule: 'A1_MOVEMENT', severity: 'HIGH', chain: 'TRON', address: 'Taddr', amount: '100' };
        },
      },
    };
    const publish = vi.fn(async () => {
      order.push('publish');
    });

    await persistAndPublishAlert({ prisma, publish }, baseInput);
    expect(order).toEqual(['persist', 'publish']);
  });

  it('a failed publish does not undo the persisted alert -- the create result is still returned', async () => {
    const prisma: AlertPersistPrisma = {
      alert: { create: async () => ({ id: 'a1', caseId: 'case1', rule: 'A1_MOVEMENT', severity: 'HIGH', chain: 'TRON', address: 'Taddr', amount: '100' }) },
    };
    const publish = vi.fn(async () => {
      throw new Error('redis down');
    });

    const result = await persistAndPublishAlert({ prisma, publish }, baseInput);
    expect(result.id).toBe('a1'); // did not throw despite publish failing
  });

  it('a failed persist never calls publish (no "successful" alert.new for something that does not exist)', async () => {
    const prisma: AlertPersistPrisma = {
      alert: {
        create: async () => {
          throw new Error('db down');
        },
      },
    };
    const publish = vi.fn(async () => {});

    await expect(persistAndPublishAlert({ prisma, publish }, baseInput)).rejects.toThrow('db down');
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes the exact alert.new payload shape', async () => {
    const prisma: AlertPersistPrisma = {
      alert: { create: async () => ({ id: 'a1', caseId: 'case1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', chain: 'TRON', address: 'Taddr', amount: '25000' }) },
    };
    const published: unknown[] = [];
    const publish = vi.fn(async (e: unknown) => {
      published.push(e);
    });

    await persistAndPublishAlert({ prisma, publish }, { ...baseInput, rule: 'A2_VASP_LANDING', severity: 'CRITICAL', amount: '25000' });
    expect(published).toEqual([{ event: 'alert.new', payload: { id: 'a1', rule: 'A2_VASP_LANDING', severity: 'CRITICAL', caseId: 'case1', chain: 'TRON', address: 'Taddr', amount: '25000' } }]);
  });
});
