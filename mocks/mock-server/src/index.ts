import { createMockNcrp } from './app';

const port = Number(process.env.MOCK_NCRP_PORT ?? 4010);
createMockNcrp().listen(port, () => console.log(`mock NCRP feed listening on :${port}`));
