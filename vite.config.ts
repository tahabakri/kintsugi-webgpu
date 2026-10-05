import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths so the build works from a GitHub Pages project subpath.
  base: './',
  build: {
    target: 'es2022',
    // Rapier ships its WebAssembly inlined, which makes one large chunk by design.
    chunkSizeWarningLimit: 3200,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
