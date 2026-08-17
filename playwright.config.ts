import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'line',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    baseURL: 'http://127.0.0.1:5180',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--ignore-gpu-blocklist',
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
        '--disable-vulkan-surface',
      ],
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5180',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
