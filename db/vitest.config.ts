import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Reads the domain source directly, so this test does not depend on a prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@inblack/domain': fileURLToPath(new URL('../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  // Integration files share one Postgres server, and migration 0004 alters the cluster-wide
  // inblack_app role: two files migrating at once could collide on it.
  test: { fileParallelism: false },
});
