import { defineConfig } from '@playwright/test';

const PORT = 5173;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * Browser tests. Locally they drive the installed Chrome, which exposes real WebGPU; on a CI
 * runner the bundled Chromium usually has no adapter, in which case the WebGPU tests skip
 * themselves and only the fallback path (tagged @fallback) is exercised.
 */
export default defineConfig({
  testDir: 'tests',
  testMatch: 'e2e.spec.ts',
  outputDir: 'test-results',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: ORIGIN,
    viewport: { width: 1440, height: 1000 },
    headless: true,
    channel: process.env.CI ? undefined : 'chrome',
    launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
