import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  ...(process.env.RESOLVEAI_VERIFY_DATABASE ? { workers: 1 } : {}),
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:5173',
    channel: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @resolveai/api dev',
      url: 'http://localhost:3001/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: 'pnpm --filter @resolveai/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
