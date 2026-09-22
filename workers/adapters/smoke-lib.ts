import { DEMO } from './testing';
import { collectTransfers } from './paginate';
import type { ChainLayer } from './index';

/** Fixed demo clock so pricing lookups (and therefore replayed results) do not depend on today's date. */
export const DEMO_NOW = DEMO.t0 + 21 * 86_400_000;

/** Reads everything the demo dataset offers through the provider layer. Used to record fixtures and to verify replay. */
export async function DEMO_READ(l: ChainLayer) {
  const btcFirst = (await l.btc.getTransfers(DEMO.btcAddr, 'out')).items[0];
  return {
    tron: (await collectTransfers(l.tron, DEMO.tronBusy, 'out')).items,
    tronMeta: { ...(await l.tron.getAccountMeta(DEMO.tronBusy)), fetchedAt: 0 },
    eth: (await collectTransfers(l.adapter('ETH'), DEMO.ethAddr, 'out')).items,
    btc: (await collectTransfers(l.btc, DEMO.btcAddr, 'out')).items,
    outspends: await l.btc.getOutspends(btcFirst.txHash),
  };
}
