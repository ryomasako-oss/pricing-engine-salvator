import { defineConfig } from "@playwright/test";

const API_PORT = process.env.E2E_API_PORT ?? "8797";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "5183";
export const BASE_URL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  // One backend, one database: the specs share it, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    storageState: "e2e/.auth/admin.json",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx e2e/serve.ts",
      url: `http://localhost:${API_PORT}/api/health`,
      env: { E2E_API_PORT: API_PORT },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --config e2e/vite.e2e.config.ts",
      url: BASE_URL,
      env: { E2E_API_PORT: API_PORT, E2E_WEB_PORT: WEB_PORT },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
