import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import { hostThreadIdSchema, parseThreadReference } from "@codexhost/shared-contracts";
import { createRendererThreadBridge } from "./renderer-thread-bridge.js";
import { openRendererThread } from "./renderer-fork-control.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";

const COPY_LABEL = /^(?:Copy (?:deep\s*)?link|复制(?:深度|深层)?链接|複製深層連結)$/iu;

function copyLabel(item: HTMLElement): Text | undefined {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (COPY_LABEL.test(node.textContent?.trim() ?? "")) return node as Text;
  }
  return undefined;
}

/** Bind the copy action only to a verified sidebar Thread from this context-menu gesture. */
export function installRendererThreadLinks(
  routing: () => RendererHostRouting | undefined,
): () => void {
  if (typeof document.createElement !== "function" || typeof MutationObserver !== "function")
    return () => {};
  const bridge = createRendererThreadBridge({
    routing,
    messages: window,
    hostIds: () =>
      [...document.querySelectorAll(SIDEBAR_THREAD_ROW_SELECTOR)]
        .map((row) => row.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE))
        .filter((id): id is string => !!id),
  });
  let context: { threadId: string; hostId: string } | undefined;
  let item: HTMLElement | undefined;
  let originalLabel: string | undefined;
  let labelNode: Text | undefined;
  let menuTimer: ReturnType<typeof setTimeout> | undefined;
  let rootMenu: HTMLElement | undefined;
  let previousMenus = new Set<Element>();
  let disposed = false;
  const reset = () => {
    if (labelNode && originalLabel !== undefined) labelNode.data = originalLabel;
    labelNode = undefined;
    item = undefined;
    originalLabel = undefined;
    context = undefined;
    rootMenu = undefined;
    previousMenus.clear();
    observer.disconnect();
    clearTimeout(menuTimer);
  };
  const scan = () => {
    if (rootMenu && !rootMenu.isConnected) {
      reset();
      return;
    }
    if (!context || item) return;
    const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(
      (menu) => !previousMenus.has(menu),
    );
    if (!rootMenu) {
      if (menus.length !== 1) return;
      rootMenu = menus[0];
    }
    const candidates = [
      ...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'),
    ].filter((candidate) => {
      const menu = candidate.closest('[role="menu"]');
      return menu && !previousMenus.has(menu) && copyLabel(candidate);
    });
    if (candidates.length !== 1) return;
    item = candidates[0];
    if (!item) return;
    labelNode = copyLabel(item);
    if (!labelNode) {
      item = undefined;
      return;
    }
    originalLabel = labelNode.data;
    labelNode.data = "复制跨机器会话链接";
  };
  const observer = new MutationObserver(scan);
  const onContextMenu = (event: MouseEvent) => {
    reset();
    const row =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)
        : null;
    const threadId = row && threadIdFromSidebarRowElement(row);
    const hostId = row?.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
    if (!threadId || !hostId) return;
    context = { threadId, hostId };
    previousMenus = new Set(document.querySelectorAll('[role="menu"]'));
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // A microtask can run between capture and the native menu's bubble handler.
    // Wait until that handler has replaced any previous menu before inspecting it.
    requestAnimationFrame(scan);
    menuTimer = setTimeout(reset, 30_000);
  };
  const report = (message: string) => {
    if (disposed) return;
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.textContent = message;
    Object.assign(status.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      borderRadius: "8px",
      background: "#202020",
      color: "#fff",
      maxWidth: "80vw",
    });
    document.body.append(status);
    setTimeout(() => status.remove(), 6000);
  };
  const copy = (event: Event) => {
    if (!context || !item || !(event.target instanceof Node) || !item.contains(event.target))
      return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selected = context;
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    void bridge
      .reference(selected.threadId, selected.hostId)
      .then((link) => {
        if (!disposed) return navigator.clipboard.writeText(link);
      })
      .then(() => report("已复制跨机器会话链接"))
      .catch((error: unknown) => report(error instanceof Error ? error.message : String(error)));
    return true;
  };
  const onClick = (event: MouseEvent) => {
    if (copy(event)) return;
    const anchor =
      event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (!href || !/^(thread:\/\/|codex:\/\/threads\/)/u.test(href) || !href.includes("machineId="))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void (async () => {
      const reference = parseThreadReference(href);
      const hostId = await bridge.hostFor(reference);
      if (!disposed)
        await openRendererThread(hostThreadIdSchema.parse(reference.threadId), { hostId });
    })().catch((error: unknown) => report(error instanceof Error ? error.message : String(error)));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") copy(event);
    if (event.key === "Escape") reset();
  };
  document.addEventListener("contextmenu", onContextMenu, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  const refresh = () => {
    void bridge.refresh().catch(() => undefined);
  };
  const interval = setInterval(refresh, 15_000);
  refresh();
  return () => {
    disposed = true;
    reset();
    clearInterval(interval);
    bridge.dispose();
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
  };
}
