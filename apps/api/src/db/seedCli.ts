import { loadEnv } from '@ps26183/shared';
import { createDriver } from '../graph/graph';
import { createPrisma } from './prisma';
import { seedGraph, seedPostgres } from './seed';

const env = loadEnv();
const prisma = createPrisma();
const driver = createDriver(env);
try {
  const { caseId, traceId } = await seedPostgres(prisma);
  const n = await seedGraph(prisma, driver, traceId);
  console.log(`seeded case ${caseId}: ${n} hops in PostgreSQL and Neo4j`);
} finally {
  await prisma.$disconnect();
  await driver.close();
}
