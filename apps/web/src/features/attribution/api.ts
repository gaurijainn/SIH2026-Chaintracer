import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { useCan } from '@/features/auth/access';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/errors';

/**
 * GET /api/v1/vasps (apps/api/src/vasps/service.ts): every registry VASP with its hot-wallet addresses. Prisma serialises the
 * hot-wallet `confidence` (Decimal) as a string, so a string or a number is accepted and kept exactly as the backend sent it.
 */
const decimal = z.union([z.string(), z.number()]).transform(String);
export const vaspRegistrySchema = z.object({
  vasps: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      type: z.string().min(1),
      jurisdiction: z.string().min(1),
      fiuStatus: z.string().min(1),
      fiuStatusDate: z.string().nullish(),
      fiuSource: z.string().nullish(),
      addresses: z.array(z.object({ chain: z.string().min(1), addr: z.string().min(1), source: z.string(), confidence: decimal })).default([]),
    }),
  ),
});
export type RegistryVasp = z.infer<typeof vaspRegistrySchema>['vasps'][number];

export function useVaspRegistry() {
  const can = useCan();
  return useQuery({
    queryKey: ['attribution', 'vasps'] as const,
    queryFn: async ({ signal }): Promise<RegistryVasp[]> => {
      const raw = await api.get<unknown>('/vasps', { signal });
      const parsed = vaspRegistrySchema.safeParse(raw);
      if (!parsed.success) throw new ApiError(502, 'INVALID_RESPONSE', 'The server returned an unexpected VASP registry response.');
      return parsed.data.vasps;
    },
    enabled: can('vasp:read'),
    staleTime: 5 * 60_000,
  });
}
