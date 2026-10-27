import { expect, test } from "@playwright/test";
import { build } from "esbuild";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererThreadLinks } from "./packages/renderer-extension/src/renderer-thread-links.ts";
      const localId = "12345678-1234-4123-8123-123456789abc";
      const remoteId = "22345678-1234-4123-8123-123456789abc";
      const routes = new Map(["local", "ssh:linux"].map(hostId => [hostId, { hostId, manager: { sendRequest: async () => ({ machineId: hostId === "local" ? localId : remoteId }) } }]));
      for (const row of document.querySelectorAll("[data-app-action-sidebar-thread-row]")) {
        const attributes = Object.fromEntries([...row.attributes].map(a => [a.name, a.value]));
        row.__reactFiber$fixture = { memoizedProps: { conversationId: row.dataset.thread, dataAttributes: attributes }, return: null };
        row.addEventListener("click", () => window.opened = row.dataset.thread);
      }
      window.nativeCopies = 0;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copied = text; } } });
      document.addEventListener("contextmenu", event => {
        event.preventDefault();
        document.querySelector("[role=menu]")?.remove();
        const menu = document.createElement("div"); menu.setAttribute("role", "menu");
        menu.innerHTML = '<button role="menuitem"><svg aria-hidden="true"><path /></svg><span>Copy deeplink</span><kbd>⌥⌘L</kbd></button><button role="menuitem">Archive</button>';
        menu.querySelector("button").addEventListener("click", () => window.nativeCopies++);
        document.body.append(menu);
      });
      window.stopLinks = installRendererThreadLinks(() => ({ forHost: id => routes.get(id) ?? null, knownHostIds: () => [...routes.keys()] }));
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  loader: { ".png": "dataurl", ".svg": "text" },
});
const bundle = outputFiles[0]?.text ?? "";

test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:43439/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>
    <style>body{background:#181818;color:#eee;font:14px system-ui;padding:40px}button{display:block;padding:12px;color:inherit;background:#292929;border:1px solid #444}svg{width:16px;height:16px}kbd{margin-left:24px;color:#999}[role=menu]{margin-top:20px}</style>
    <button data-thread="local-thread" data-app-action-sidebar-thread-row="local-row" data-app-action-sidebar-thread-id="local:local-thread" data-app-action-sidebar-thread-host-id="local">本机会话</button>
    <button data-thread="linux-thread" data-app-action-sidebar-thread-row="linux-row" data-app-action-sidebar-thread-id="ssh:linux:linux-thread" data-app-action-sidebar-thread-host-id="ssh:linux">Linux 会话</button>
    <button id="unrelated">其他区域</button>
  </body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1:43439/");
  await page.addScriptTag({ content: bundle });
});

test("right-click copies the selected Host's portable link, preserves icons and shortcuts, and supports keyboard", async ({
  page,
}) => {
  await page.getByText("Linux 会话", { exact: true }).click({ button: "right" });
  const copy = page.getByRole("menuitem", { name: /复制跨机器会话链接/ });
  await expect(copy).toBeVisible();
  await expect(copy.locator("svg")).toHaveCount(1);
  await expect(copy.locator("kbd")).toHaveText("⌥⌘L");
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied?: string }).copied))
    .toBe(
      "thread://linux-thread?hostId=ssh%3Alinux&machineId=22345678-1234-4123-8123-123456789abc",
    );
  expect(
    await page.evaluate(() => (window as unknown as { nativeCopies: number }).nativeCopies),
  ).toBe(0);
  await page.getByText("本机会话", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /复制跨机器会话链接/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied?: string }).copied))
    .toContain("thread://local-thread?hostId=local&machineId=12345678-");
});

test("leaves unrelated menus alone and follows a portable link using machine identity", async ({
  page,
}) => {
  await page.locator("#unrelated").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Copy deeplink/ })).toBeVisible();
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href =
      "thread://linux-thread?hostId=local&machineId=22345678-1234-4123-8123-123456789abc";
    anchor.textContent = "打开 Linux 会话";
    document.body.append(anchor);
  });
  await page.getByRole("link", { name: "打开 Linux 会话" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { opened?: string }).opened))
    .toBe("linux-thread");
});
