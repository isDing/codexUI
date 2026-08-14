import { expect, test, type Page } from "@playwright/test";

const password = process.env.CODEXUI_E2E_PASSWORD;

if (!password) {
  throw new Error("CODEXUI_E2E_PASSWORD is required for browser tests");
}

async function login(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Codex UI" })).toBeVisible();
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Codex 在线")).toBeVisible();
}

test("desktop login, thread navigation, and history rendering", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Codex UI" })).toBeVisible();
  await page.screenshot({ path: "test-results/login-desktop.png", fullPage: true });

  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Codex 在线")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作区" })).toBeVisible();

  await page.locator(".workspace-row").filter({ hasText: "/home/user/code/agent" }).click();
  const thread = page.locator(".thread-row").first();
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(page.getByPlaceholder("发送新的需求")).toBeVisible();
  await expect(page.locator(".message").first()).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-desktop.png", fullPage: true });

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("mobile drawers and conversation remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  await page.getByRole("button", { name: "工作区" }).click();
  await expect(page.locator(".workspace-sidebar.drawer-open")).toBeVisible();
  await page.locator(".workspace-row").filter({ hasText: "/home/user/code/agent" }).click();
  await expect(page.locator(".thread-sidebar.drawer-open")).toBeVisible();
  await page.locator(".thread-row").first().click();
  await expect(page.getByPlaceholder("发送新的需求")).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-mobile.png", fullPage: true });

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.composer?.width).toBeGreaterThan(300);
});
