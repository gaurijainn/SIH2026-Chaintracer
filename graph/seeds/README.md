The seed graph is written by `pnpm --filter @ps26183/api db:seed` (see `apps/api/prisma/seed.ts`).
It reads the sample case's hops back out of PostgreSQL and MERGEs them into Neo4j, so both stores
hold the same edges. Sample data lives in `packages/shared/src/sampleCase.ts` (synthetic only).
