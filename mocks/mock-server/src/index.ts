import { createMockNcrp, createMockSahyog } from './app';

const ncrpPort = Number(process.env.MOCK_NCRP_PORT ?? 4010);
createMockNcrp().listen(ncrpPort, () => console.log(`mock NCRP feed listening on :${ncrpPort}`));

const sahyogPort = Number(process.env.MOCK_SAHYOG_PORT ?? 4011);
createMockSahyog().listen(sahyogPort, () => console.log(`mock SAHYOG submissions listening on :${sahyogPort}`));
