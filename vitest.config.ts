import { defineConfig } from 'vitest/config';

// Unit and integration tests for the workspace packages and the web app's server/lib code.
// Integration tests that need Redis/Postgres read REDIS_URL / DATABASE_URL (see .env.example) and skip when
// the services are not reachable.
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/web/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
