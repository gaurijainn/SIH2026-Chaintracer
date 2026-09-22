import { describe, expect, it } from 'vitest';
import { detectDirectLabelHit } from './directLabel';

describe('detectDirectLabelHit (H4)', () => {
  it('matches a label that already carries a vaspId', () => {
    const [m] = detectDirectLabelHit([{ addr: 'A', vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.8, source: 'eth-labels', name: 'Some Exchange Hot Wallet' }]);
    expect(m).toMatchObject({ vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.8, evidence: { viaAddr: 'A', source: 'eth-labels' } });
  });

  it('ignores labels with no vaspId (e.g. a bare "sanctioned" or "reported" flag)', () => {
    expect(detectDirectLabelHit([{ addr: 'A', vaspId: null, vaspName: '', confidence: 1, source: 'ofac', name: 'OFAC SDN' }])).toEqual([]);
  });

  it('surfaces a hit via a cluster-mate address distinctly from a hit on the address itself', () => {
    const matches = detectDirectLabelHit([{ addr: 'CLUSTER_MATE', vaspId: 'v1', vaspName: 'Some Exchange', confidence: 0.8, source: 'eth-labels', name: 'x' }]);
    expect(matches[0].evidence.viaAddr).toBe('CLUSTER_MATE');
  });

  it('returns one match per labeled address, unfiltered by VASP (the caller combines them)', () => {
    const matches = detectDirectLabelHit([
      { addr: 'A', vaspId: 'v1', vaspName: 'Exchange One', confidence: 0.8, source: 'eth-labels', name: 'x' },
      { addr: 'A', vaspId: 'v1', vaspName: 'Exchange One', confidence: 0.5, source: 'chainabuse', name: 'y' },
    ]);
    expect(matches).toHaveLength(2);
  });
});
