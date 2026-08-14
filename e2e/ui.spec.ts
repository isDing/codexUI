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
  await expect(page.getByText("v1.0.4", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "工作区" })).toBeVisible();

  await page.locator(".workspace-row").filter({ hasText: "/home/user/code/agent" }).click();
  const thread = page.locator(".thread-row").first();
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(page.getByPlaceholder("发送新的需求")).toBeVisible();
  await expect(page.locator(".message").first()).toBeVisible();
  await expect(page.locator(".agent-message .markdown-body").first()).toBeVisible();
  const processDetails = page.locator("details.reasoning-item, details.tool-item, details.commentary-message");
  const openProcessDetails = page.locator("details.reasoning-item[open], details.tool-item[open], details.commentary-message[open]");
  expect(await processDetails.count()).toBe(0);
  await page.getByRole("button", { name: "展开过程" }).click();
  await expect(page.getByRole("button", { name: "收起过程" })).toBeVisible();
  const processCount = await processDetails.count();
  expect(processCount).toBeGreaterThan(0);
  await expect.poll(() => openProcessDetails.count()).toBe(processCount);
  await expect(processDetails.first()).toBeVisible();
  await page.getByRole("button", { name: "收起过程" }).click();
  await expect.poll(() => processDetails.count()).toBe(0);
  await page.screenshot({ path: "test-results/conversation-desktop.png", fullPage: true });

  await page.getByRole("button", { name: "code /home/user/code" }).click();
  await page.locator(".thread-row").filter({ hasText: "在这个目录下新建" }).first().click();
  await expect(page.locator(".session-controls select").first()).toHaveValue("gpt-5.6-sol");
  await expect(page.locator(".session-controls select").nth(1)).toHaveValue("xhigh");
  await expect(page.locator(".access-toggle input")).toBeChecked();

  await page.reload();
  await expect(page.getByPlaceholder("发送新的需求")).toBeVisible();
  await expect(page.locator(".workspace-row.selected").filter({ hasText: "/home/user/code" })).toBeVisible();
  await expect(page.locator(".thread-row.selected").filter({ hasText: "在这个目录下新建" })).toBeVisible();
  await page.getByRole("button", { name: "新建会话" }).click();
  await expect(page.locator(".dialog select").first()).toHaveValue("/home/user/code");
  await page.getByRole("button", { name: "取消" }).click();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.route("**/api/threads/*/turns", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        turn: {
          id: "e2e-empty-turn",
          items: [{ id: "e2e-final", type: "agentMessage", phase: "final_answer", text: "E2E 模拟最终回答" }],
          status: "inProgress",
          error: null,
          startedAt: Math.floor(Date.now() / 1000),
          completedAt: null,
          durationMs: null,
        },
      }),
    });
  });
  const requestEcho = "E2E 用户消息回显";
  await page.getByPlaceholder("发送新的需求").fill(requestEcho);
  await page.getByTitle("发送").click();
  await expect(page.locator(".user-message .message-body").filter({ hasText: requestEcho })).toBeVisible();
  await expect(page.locator(".agent-message .message-body").filter({ hasText: "E2E 模拟最终回答" })).toBeVisible();
  const messageOrder = await page.locator(".turn-block").last().locator(".message").evaluateAll((messages) => messages.map((message) => message.textContent ?? ""));
  expect(messageOrder.findIndex((message) => message.includes(requestEcho))).toBeLessThan(messageOrder.findIndex((message) => message.includes("E2E 模拟最终回答")));
  await page.unroute("**/api/threads/*/turns");
});

test("mobile drawers and conversation remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await expect(page.locator(".workspace-sidebar.drawer-open")).toBeVisible();
  await page.getByRole("button", { name: "新增工作区", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新增工作区" })).toBeVisible();
  await expect(page.getByLabel("工作区路径")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
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
