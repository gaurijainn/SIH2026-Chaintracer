import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useCan } from '@/features/auth/access';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';

/**
 * GET /api/v1/addresses/:chain/:addr/risk (apps/api/src/risk/routes.ts). Every field the F5 panel shows comes from here:
 * a factor is `{feature, impact, reason}` (the feature VALUE is only inside the reason text; the API returns no separate
 * value), `overrides` lists the rule overrides that fired (SANCTIONED, STABLECOIN_BLACKLIST), and `createdAt` is when this
 * score was computed. There is NO GET /addresses/:chain/:addr profile route in the backend, so flags beyond overrides,
 * activity and counterparties are not available from an address endpoint (see derive.ts for what is derived from the graph).
 */
export const riskSchema = z.object({
  chain: z.string().min(1),
  addr: z.string().min(1),
  score: z.number().int().min(0).max(100),
  band: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  factors: z.array(z.object({ feature: z.string().min(1), impact: z.number().finite(), reason: z.string().min(1) })),
  overrides: z.array(z.string()),
  typology: z.string().nullable(),
  typologyConfidence: z.number().min(0).max(1).nullable(),
  modelVersion: z.string().min(1),
  traceId: z.string().nullable(),
  createdAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp'),
});
export type AddressRisk = z.infer<typeof riskSchema>;

/** The v1 model is TRON-only; other chains answer 400 UNSUPPORTED_CHAIN, so the UI never asks for them. */
export const RISK_CHAINS: readonly string[] = ['TRON'];
export const riskSupported = (chain: string) => RISK_CHAINS.includes(chain);

export const walletKeys = {
  risk: (chain: string, addr: string, traceId: string | null) => ['address-risk', chain, addr, traceId] as const,
};

/**
 * Fetched only for the wallet the officer opens (`enabled`), scoped to the case trace so the backend can use trace context.
 * The backend stores a score row on every call, so a long staleTime keeps re-opening a wallet from re-running the model.
 */
export function useAddressRisk(chain: string, addr: string, traceId: string | null, enabled: boolean) {
  const can = useCan();
  return useQuery({
    queryKey: walletKeys.risk(chain, addr, traceId),
    // No AbortSignal on purpose: each call runs the model and stores a score row, so a remount (StrictMode) must reuse the
    // in-flight request rather than cancel it and send a second one.
    queryFn: async (): Promise<AddressRisk> => {
      const raw = await api.get<unknown>(`/addresses/${encodeURIComponent(chain)}/${encodeURIComponent(addr)}/risk`, { query: { traceId } });
      const parsed = riskSchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected risk response.');
      return parsed.data;
    },
    enabled: enabled && riskSupported(chain) && can('risk:read'),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
}
