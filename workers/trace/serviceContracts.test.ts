import { describe, expect, it } from 'vitest';
import { BRIDGE_CONTRACTS, DEX_ROUTERS, isBridgeContract, isDexRouter } from './serviceContracts';

describe('isDexRouter', () => {
  it('matches a known TRON router exactly (Base58 is case-sensitive)', () => {
    const addr = DEX_ROUTERS.TRON![0];
    expect(isDexRouter('TRON', addr)).toBe(true);
    expect(isDexRouter('TRON', addr.toLowerCase())).toBe(false);
  });

  it('matches a known EVM router case-insensitively', () => {
    const addr = DEX_ROUTERS.ETH![0];
    expect(isDexRouter('ETH', addr.toUpperCase())).toBe(true);
    expect(isDexRouter('ETH', addr.toLowerCase())).toBe(true);
  });

  it('returns false for an address not on any router list', () => {
    expect(isDexRouter('ETH', '0x0000000000000000000000000000000000dead')).toBe(false);
  });
});

describe('isBridgeContract', () => {
  it('matches a known bridge contract on its chain', () => {
    const addr = BRIDGE_CONTRACTS.TRON![0];
    expect(isBridgeContract('TRON', addr)).toBe(true);
  });

  it('does not cross chains: a TRON bridge address is not a bridge on ETH', () => {
    const addr = BRIDGE_CONTRACTS.TRON![0];
    expect(isBridgeContract('ETH', addr)).toBe(false);
  });

  it('returns false for a chain with no known bridge contracts', () => {
    expect(isBridgeContract('BSC', '0x0000000000000000000000000000000000dead')).toBe(false);
  });
});
