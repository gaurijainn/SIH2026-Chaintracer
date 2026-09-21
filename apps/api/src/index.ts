import { loadEnv } from '@ps26183/shared';
import { createApp } from './app';
import { buildDeps } from './deps';

const env = loadEnv();
const { deps, close } = buildDeps(env);
const server = createApp(deps).listen(env.API_PORT, () => {
  console.log(`api listening on :${env.API_PORT} (DATA_MODE=${env.DATA_MODE})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => void close().then(() => process.exit(0)));
  });
}
