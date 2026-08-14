import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.CODEXUI_BASE_URL ?? "http://127.0.0.1:3100",
    locale: "zh-CN",
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
});
