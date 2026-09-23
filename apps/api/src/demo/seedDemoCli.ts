import { DEMO_CASES, loadEnv } from '@ps26183/shared';
import { AuditService } from '../audit/service';
import { loadSecurityConfig } from '../auth/config';
import { PiiCipher } from '../auth/pii';
import { createPrisma } from '../db/prisma';
import { seedPostgres } from '../db/seed';
import { createDriver } from '../graph/graph';
import { seedDemoCase } from './seedDemo';

/** `pnpm --filter @ps26183/api demo:seed` -- loads the golden + two backup demo cases in replay mode (no network). */
const env = loadEnv({ ...process.env, DATA_MODE: 'replay' });
const pii = new PiiCipher(loadSecurityConfig(env).piiKey);
const prisma = createPrisma();
const driver = createDriver(env);
try {
  await seedPostgres(prisma); // demo users (idempotent)
  const actor = await prisma.user.findUniqueOrThrow({ where: { email: 'investigator@demo.local' } });
  const audit = new AuditService({ prisma });
  for (const c of DEMO_CASES) {
    const r = await seedDemoCase({ prisma, driver, audit, pii, actorId: actor.id }, c);
    console.log(`${c.key}: case ${r.caseId} | ${r.hops} hops | attributed to ${r.attributedVasp} | alerts ${r.alerts.map((a) => `${a.rule}/${a.severity}`).join(', ')}`);
  }
} finally {
  await prisma.$disconnect();
  await driver.close();
}
