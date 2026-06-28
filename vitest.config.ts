// ─────────────────────────────────────────────────────────────────────────────
// Vitest Config — Test runner configuration for the Softshape backend
// ─────────────────────────────────────────────────────────────────────────────
// Configures Vitest for backend unit and integration tests:
//   - Environment: node (not jsdom)
//   - Globals: true (describe, it, expect available globally)
//   - Test files: src/**/*.test.ts
//   - Timeout: 30s (generous for database tests)
//   - File parallelism: false (sequential to avoid DB conflicts)
// ─────────────────────────────────────────────────────────────────────────────

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    fileParallelism: false,
  },
});
