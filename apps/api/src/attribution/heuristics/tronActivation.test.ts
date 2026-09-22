import { describe, expect, it } from 'vitest';
import type { AccountMeta } from '@ps26183/shared';
import { detectTronActivation, type KnownActivator } from './tronActivation';

const meta = (activator: string | null): AccountMeta => ({ chain: 'TRON', addr: 'TABC', createdAt: 1000, activator, publicTag: null, flags: {}, sources: [], fetchedAt: 2000 });
const ACTIVATOR: KnownActivator = { addr: 'TACTIVATOR', vaspId: 'v1', vaspName: 'Some Exchange' };

describe('detectTronActivation (H2)', () => {
  it('fires when the account was activated by a known exchange activator wallet', () => {
    const [m] = detectTronActivation(meta('TACTIVATOR'), [ACTIVATOR]);
    expect(m).toMatchObject({ vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.6, evidence: { activator: 'TACTIVATOR', createdAt: 1000 } });
  });

  it('does not fire when there is no activator on record', () => {
    expect(detectTronActivation(meta(null), [ACTIVATOR])).toEqual([]);
  });

  it('does not fire when the activator is not on the known-activator list', () => {
    expect(detectTronActivation(meta('TSOMEONE_ELSE'), [ACTIVATOR])).toEqual([]);
  });
});
