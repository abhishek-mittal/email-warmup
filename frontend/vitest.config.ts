import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // `server-only` throws when imported outside a React Server Component
      // bundle; under test it is replaced by an empty module.
      'server-only': path.resolve(__dirname, 'test-stubs/server-only.ts'),
    },
  },
});
