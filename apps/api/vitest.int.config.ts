import { defineConfig } from 'vitest/config';

// Integration tests need PostgreSQL + Neo4j (docker compose up -d postgres neo4j).
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
