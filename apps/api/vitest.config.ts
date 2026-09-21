import { defineConfig } from 'vitest/config';

// Unit tests only. Integration tests (need PostgreSQL + Neo4j) use vitest.int.config.ts.
export default defineConfig({
  test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.int.test.ts', '**/node_modules/**'] },
});
