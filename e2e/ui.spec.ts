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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 会话内容可见的判定：消息、空会话占位、过程项或中断提示任一出现即可 */
const CONTENT = ".message, .new-thread-state, .reasoning-item, .tool-item, .interrupted-note";

/** 选择第一个「会话数不为 0」的工作区，并返回其路径（不依赖任何硬编码数据）。 */
async function openFirstPopulatedWorkspace(page: Page): Promise<string> {
  const rows = page.locator(".workspace-row");
  await expect(rows.first()).toBeVisible();
  const path = await rows.evaluateAll((elements: HTMLElement[]) => {
    const row = elements.find((element) => {
      const badge = element.querySelector<HTMLElement>(".count-badge")?.textContent?.trim() ?? "0";
      return badge !== "0";
    });
    return row?.querySelector<HTMLElement>(".workspace-copy small")?.textContent?.trim() ?? "";
  });
  if (!path) throw new Error("测试实例上没有包含会话的工作区");
  // 路径完全相等匹配，避免 /home/user/code 同时命中其子目录
  const row = page.locator(".workspace-row").filter({
    has: page.locator(".workspace-copy small", { hasText: new RegExp(`^${escapeRegExp(path)}$`) }),
  });
  await expect(row).toHaveCount(1);
  await row.click();
  return path;
}

/** 选择第一个非进行中的会话（进行中的会话无法发送消息）。 */
async function openFirstIdleThread(page: Page) {
  const thread = page.locator(".thread-row").filter({ hasNot: page.locator(".active-icon") }).first();
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(page.getByPlaceholder("发送新的需求")).toBeVisible();
}

test("desktop login, thread navigation, and history rendering", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Codex UI" })).toBeVisible();
  await page.screenshot({ path: "test-results/login-desktop.png", fullPage: true });

  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("Codex 在线")).toBeVisible();
  await expect(page.locator(".app-version").first()).toHaveText(/^v\d+\.\d+\.\d+$/);
  await expect(page.getByRole("navigation", { name: "工作区" })).toBeVisible();

  await openFirstPopulatedWorkspace(page);
  await openFirstIdleThread(page);

  // 历史渲染：空会话显示新会话占位，否则至少有一条消息
  await expect(page.locator(CONTENT).first()).toBeVisible();
  const agentBody = page.locator(".agent-message .markdown-body");
  if ((await agentBody.count()) > 0) await expect(agentBody.first()).toBeVisible();

  // 过程展开/收起（纯过程内容的轮次始终展示，不受折叠开关影响）
  const processDetails = page.locator("details.reasoning-item, details.tool-item, details.commentary-message");
  const openProcessDetails = page.locator("details.reasoning-item[open], details.tool-item[open], details.commentary-message[open]");
  const initialOpen = await openProcessDetails.count();
  await page.getByRole("button", { name: "展开过程" }).click();
  await expect(page.getByRole("button", { name: "收起过程" })).toBeVisible();
  const processCount = await processDetails.count();
  if (processCount > 0) {
    await expect.poll(() => openProcessDetails.count()).toBe(processCount);
    await expect(processDetails.first()).toBeVisible();
  }
  await page.getByRole("button", { name: "收起过程" }).click();
  await expect.poll(() => openProcessDetails.count()).toBe(initialOpen);
  await page.screenshot({ path: "test-results/conversation-desktop.png", fullPage: true });

  // 记录当前会话的偏好设置与所在工作区
  const modelValue = await page.locator(".session-controls select").first().inputValue();
  const effortValue = await page.locator(".session-controls select").nth(1).inputValue();
  const fullAccess = await page.locator(".access-toggle input").isChecked();
  const workspacePath = await page.locator(".workspace-row.selected .workspace-copy small").textContent();

  // 刷新后：选中项与偏好设置应完整恢复
  await page.reload();
  await expect(page.getByPlaceholder("发送新的需求")).toBeVisible();
  await expect(page.locator(".workspace-row.selected")).toHaveCount(1);
  await expect(page.locator(".workspace-row.selected .workspace-copy small")).toHaveText(workspacePath?.trim() ?? "");
  await expect(page.locator(".thread-row.selected")).toHaveCount(1);
  await expect(page.locator(".session-controls select").first()).toHaveValue(modelValue);
  await expect(page.locator(".session-controls select").nth(1)).toHaveValue(effortValue);
  await expect(page.locator(".access-toggle input")).toBeChecked({ checked: fullAccess });

  // 新建会话对话框默认选中当前工作区
  await page.getByRole("button", { name: "新建会话" }).click();
  await expect(page.locator(".dialog select").first()).toHaveValue(workspacePath?.trim() ?? "");
  await page.getByRole("button", { name: "取消" }).click();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // 模拟发送：拦截 turn 创建请求，验证用户消息回显与最终回答渲染顺序
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

test("switching between threads stays instant and never wedges on the loading screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await login(page);
  await openFirstPopulatedWorkspace(page);

  const threads = page.locator(".thread-row");
  await expect(threads.first()).toBeVisible();
  const count = await threads.count();
  test.skip(count < 2, "需要至少两个会话");

  // 首次加载两个会话
  await threads.nth(0).click();
  await expect(page.locator(CONTENT).first()).toBeVisible();
  await threads.nth(1).click();
  await expect(page.locator(CONTENT).first()).toBeVisible();

  // 切回第一个会话：缓存命中，不应出现整屏加载动画
  await threads.nth(0).click();
  await expect(page.locator(".history-loading")).toHaveCount(0);
  await expect(page.locator(CONTENT).first()).toBeVisible();

  // 快速连续切换后必须能稳定恢复到内容视图（防止加载状态卡死）
  for (let i = 0; i < Math.min(count, 8); i++) {
    await threads.nth(i).click();
    await page.waitForTimeout(40);
  }
  await expect(page.locator(".history-loading")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(CONTENT).first()).toBeVisible({ timeout: 15_000 });
});

test("refresh while WebSocket is still connecting never crashes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const { threadId } = await page.evaluate(async () => {
    const res = await fetch("/api/bootstrap");
    const data = await res.json();
    return { threadId: data.threads[0]?.id ?? "" };
  });
  test.skip(!threadId, "需要至少一个会话");

  // 预置“上次选中会话”并延迟 WebSocket 握手，复现刷新时 WS 仍在 CONNECTING 的场景
  await page.addInitScript((tid) => {
    window.localStorage.setItem("codex-ui.selected-thread", tid);
  }, threadId);
  await page.routeWebSocket("**/ws", (ws) => {
    setTimeout(() => ws.connectToServer(), 2000);
  });

  await page.reload();
  await expect(page.locator(".crash-screen")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(CONTENT).first()).toBeVisible({ timeout: 15_000 });
});

test("mobile drawers and conversation remain usable", async ({ page }) => {  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);

  await page.getByRole("button", { name: "工作区", exact: true }).click();
  await expect(page.locator(".workspace-sidebar.drawer-open")).toBeVisible();
  await page.getByRole("button", { name: "新增工作区", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "新增工作区" })).toBeVisible();
  await expect(page.getByLabel("工作区路径")).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await openFirstPopulatedWorkspace(page);
  await expect(page.locator(".thread-sidebar.drawer-open")).toBeVisible();
  await page.locator(".thread-row").first().click();
  await expect(page.locator(CONTENT).first()).toBeVisible();
  await page.screenshot({ path: "test-results/conversation-mobile.png", fullPage: true });

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    composer: document.querySelector(".composer")?.getBoundingClientRect().toJSON(),
    scroller: (() => {
      const el = document.querySelector(".conversation-scroll");
      return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
    })(),
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.composer?.width).toBeGreaterThan(300);
  // 消息区不允许横向溢出：长代码块等宽内容必须在气泡内部滚动，而不是撑宽页面
  if (dimensions.scroller) {
    expect(dimensions.scroller.scrollWidth).toBeLessThanOrEqual(dimensions.scroller.clientWidth + 1);
  }
});
