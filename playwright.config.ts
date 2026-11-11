import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const port = Number(process.env.E2E_PORT || 3015);
const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
export default defineConfig({
  testDir: './tests',
  testMatch: 'browser.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { ...(existsSync(chromium) ? { executablePath: chromium } : {}) },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: `/tmp/course-browser-${process.pid}` },
  },
});
