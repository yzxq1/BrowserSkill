import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSessionStart, handleSessionStop } from "@/tools/session";
import { resolveTargetTab } from "@/tools/shared";
import {
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
  type TabMutationApi,
} from "@/tools/tabs";
import { handleWindowResize } from "@/tools/window";
import { chromeExistingWindowApi } from "../existing-window";
import { isAgentControlledTab, SessionManager } from "../manager";
import { withTaskPopups } from "../task-popups";
import { AgentWindowRouting } from "../window-routing";

function fixture() {
  const agentWindow = {
    create: vi.fn(async () => ({ windowId: 99, initialTabIds: [990] })),
    ensureActiveTab: vi.fn(async () => 990),
    remove: vi.fn(async () => {}),
  };
  const existingWindow = {
    resolveCurrentWindow: vi.fn(async () => 7),
    get: vi.fn(
      async (id: number) => ({ id, type: "normal", incognito: false }) as chrome.windows.Window,
    ),
    createTaskTab: vi.fn(async () => 20),
  };
  const tabGroups = {
    create: vi.fn(async () => 70),
    add: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const manager = new SessionManager({ agentWindow, existingWindow, tabGroups });
  const pages = new Map<number, chrome.tabs.Tab>([
    [
      10,
      { id: 10, windowId: 7, active: true, index: 0, url: "https://user.test/" } as chrome.tabs.Tab,
    ],
    [20, { id: 20, windowId: 7, active: false, index: 1, url: "about:blank" } as chrome.tabs.Tab],
  ]);
  const tabs: TabMutationApi = {
    get: vi.fn(async (id) => {
      const tab = pages.get(id);
      if (!tab) throw new Error("missing");
      return tab;
    }),
    create: vi.fn(async (props) => {
      const tab = { ...props, id: 30, index: 2 } as chrome.tabs.Tab;
      pages.set(30, tab);
      return tab;
    }),
    update: vi.fn(async (id, props) => ({ ...pages.get(id), ...props }) as chrome.tabs.Tab),
    move: vi.fn(),
    remove: vi.fn(async () => {}),
  };
  const query = vi.fn(async () => [...pages.values()]);
  const resetAgentOverlays = vi.fn(async () => {});
  const releaseSessionTab = vi.fn(async () => {});
  const detachSession = vi.fn(async () => {});
  const deps = {
    tabs,
    tabGroups,
    agentOverlayReset: { resetAgentOverlays },
    cdp: { releaseSessionTab, detachSession },
  };
  return {
    manager,
    existingWindow,
    agentWindow,
    tabGroups,
    tabs,
    pages,
    query,
    deps,
    resetAgentOverlays,
    detachSession,
    releaseSessionTab,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("existing user window sessions", () => {
  it("uses a clear existing-window API and creates only a background blank tab at the end", async () => {
    const create = vi.fn(async () => ({ id: 20 }));
    const get = vi.fn(async () => ({ id: 7 }));
    vi.stubGlobal("chrome", { windows: { get }, tabs: { create } });
    await chromeExistingWindowApi.get(7);
    expect(await chromeExistingWindowApi.createTaskTab(7)).toBe(20);
    expect(get).toHaveBeenCalledWith(7);
    expect(create).toHaveBeenCalledExactlyOnceWith({
      windowId: 7,
      url: "about:blank",
      active: false,
    });
  });
  it("starts without creating or activating a window and resolves the task default rather than active user page", async () => {
    const f = fixture();
    expect(await handleSessionStart(f.manager, { session_id: "a", window_id: 7 })).toMatchObject({
      agent_window_id: 7,
      default_tab_id: 20,
      window_mode: "existing",
    });
    const ctx = f.manager.get("a")!;
    expect(
      await resolveTargetTab(f.manager, ctx, undefined, { get: f.tabs.get, query: f.query }),
    ).toMatchObject({ tabId: 20, active: false });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.tabs.get).not.toHaveBeenCalledWith(10);
    expect(f.tabGroups.create).toHaveBeenCalledWith(20);
    expect(f.agentWindow.create).not.toHaveBeenCalled();
    expect(f.agentWindow.ensureActiveTab).not.toHaveBeenCalled();
  });
  it("refuses unowned reads and close, classifies same-window user tabs as user", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    expect(
      await resolveTargetTab(f.manager, ctx, 10, { get: f.tabs.get, query: f.query }),
    ).toMatchObject({ code: "permission_denied" });
    expect(await handleTabClose(f.manager, { session_id: "a", tab_id: 10 }, f.deps)).toMatchObject({
      code: "permission_denied",
    });
    expect(f.tabs.remove).not.toHaveBeenCalled();
    expect(
      await handleTabList(f.manager, { session_id: "a", scope: "user" }, { query: f.query }),
    ).toMatchObject({ tabs: [{ tab_id: 10, scope: "user" }] });
  });
  it("requires approval, borrows in place without activation, and returns in place releasing CDP and refs", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    expect(await handleTabBorrow(f.manager, { session_id: "a", tab_id: 10 }, f.deps)).toMatchObject(
      { code: "permission_denied" },
    );
    const approveBorrow = vi.fn(async () => true);
    expect(
      await handleTabBorrow(
        f.manager,
        { session_id: "a", tab_id: 10 },
        { ...f.deps, approveBorrow },
      ),
    ).toMatchObject({ tab_id: 10, original_window_id: 7 });
    expect(approveBorrow).toHaveBeenCalledOnce();
    expect(ctx.defaultTabId).toBe(10);
    expect(f.tabs.move).not.toHaveBeenCalled();
    expect(f.tabs.update).not.toHaveBeenCalled();
    expect(f.tabGroups.add).toHaveBeenCalledWith(70, 10);
    f.pages.get(10)!.groupId = 70;
    expect(await handleTabReturn(f.manager, { session_id: "a", tab_id: 10 }, f.deps)).toMatchObject(
      { tab_id: 10, returned_to_window_id: 7 },
    );
    expect(ctx.borrowedTabs.has(10)).toBe(false);
    expect(f.tabGroups.remove).toHaveBeenCalledWith(10);
    expect(ctx.defaultTabId).toBe(20);
    expect(f.releaseSessionTab).toHaveBeenCalledWith("a", 10);
    expect(f.resetAgentOverlays).toHaveBeenCalledWith(10, "a");
    expect(f.tabs.move).not.toHaveBeenCalled();
  });
  it("groups subsequent task tabs in BSK2", async () => {
    const f = fixture();
    await f.manager.start("a", { windowId: 7 });
    await handleTabCreate(f.manager, { session_id: "a" }, f.deps);
    expect(f.tabGroups.add).toHaveBeenCalledWith(70, 30);
  });
  it("preserves every page and window during stop, while dropping all authority", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    await handleTabBorrow(
      f.manager,
      { session_id: "a", tab_id: 10 },
      { ...f.deps, approveBorrow: async () => true },
    );
    expect(
      await handleSessionStop(
        f.manager,
        { session_id: "a" },
        { ...f.deps, tabManagement: f.deps, tabsQuery: { get: f.tabs.get, query: f.query } },
      ),
    ).toMatchObject({ window_released: true, returned_tab_ids: [10] });
    expect(f.detachSession).toHaveBeenCalledWith("a");
    expect(f.tabs.remove).not.toHaveBeenCalled();
    expect(f.tabs.move).not.toHaveBeenCalled();
    expect(f.agentWindow.remove).not.toHaveBeenCalled();
    expect(f.tabGroups.remove).toHaveBeenCalledWith(20);
    expect(f.pages.size).toBe(2);
    expect(f.manager.get("a")).toBeNull();
    expect(isAgentControlledTab(ctx, 20)).toBe(false);
  });
  it("creates subsequent tabs in background and refuses resize", async () => {
    const f = fixture();
    await f.manager.start("a", { windowId: 7 });
    await handleTabCreate(f.manager, { session_id: "a" }, f.deps);
    expect(f.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 7, active: false }),
    );
    const update = vi.fn();
    expect(
      await handleWindowResize(f.manager, { session_id: "a", width: 800, height: 600 }, { update }),
    ).toMatchObject({ code: "permission_denied" });
    expect(update).not.toHaveBeenCalled();
  });
  it.each([
    { incognito: true },
    { incognito: false },
    { width: 800, height: 600 },
    { focused: true },
    { window_id: -2 },
  ])("rejects incompatible start options %j", async (options) => {
    const f = fixture();
    expect(
      await handleSessionStart(f.manager, { session_id: "a", window_id: 7, ...options }),
    ).toMatchObject({ code: "invalid_params" });
    expect(f.existingWindow.get).not.toHaveBeenCalled();
  });
  it.each([
    { type: "popup", incognito: false },
    { type: "normal", incognito: true },
  ])("refuses nonordinary windows %j", async (window) => {
    const f = fixture();
    f.existingWindow.get.mockResolvedValue({ id: 7, ...window } as chrome.windows.Window);
    await expect(f.manager.start("a", { windowId: 7 })).rejects.toThrow();
    expect(f.existingWindow.createTaskTab).not.toHaveBeenCalled();
    expect(f.agentWindow.remove).not.toHaveBeenCalled();
  });
  it("reserves windows and session ids before awaited startup; cancellation releases reservation without deleting tabs", async () => {
    const f = fixture();
    const ac = new AbortController();
    let finish!: (id: number) => void;
    f.existingWindow.createTaskTab.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const first = f.manager.start("a", { windowId: 7, signal: ac.signal });
    await vi.waitFor(() => expect(f.existingWindow.createTaskTab).toHaveBeenCalled());
    await expect(f.manager.start("b", { windowId: 7 })).rejects.toThrow("Window already");
    await expect(f.manager.start("a", { windowId: 8 })).rejects.toThrow("already exists");
    ac.abort();
    finish(20);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(f.agentWindow.remove).not.toHaveBeenCalled();
    expect(f.tabs.remove).not.toHaveBeenCalled();
    await expect(f.manager.start("b", { windowId: 7 })).resolves.toMatchObject({
      existingWindow: true,
    });
  });
  it("resolves current and still rejects a concurrently reserved or dedicated window", async () => {
    const f = fixture();
    expect(await handleSessionStart(f.manager, { session_id: "a", window_id: -1 })).toMatchObject({
      agent_window_id: 7,
      window_mode: "existing",
    });
    expect(f.existingWindow.resolveCurrentWindow).toHaveBeenCalledWith(new Set());
    await expect(f.manager.start("b", { windowId: -1 })).rejects.toThrow("Window already");
    expect(f.existingWindow.resolveCurrentWindow).toHaveBeenLastCalledWith(new Set([7]));
  });
  it.each([
    {
      windows: [{ id: 7, type: "normal", focused: true }],
      last: { id: 8, type: "normal" },
      expected: 7,
    },
    {
      windows: [{ id: 7, type: "normal", focused: false }],
      last: { id: 8, type: "normal" },
      expected: 8,
    },
    {
      windows: [
        { id: 99, type: "normal", focused: true },
        { id: 7, type: "normal" },
      ],
      last: { id: 99, type: "normal" },
      expected: null,
    },
    {
      windows: [{ id: 7, type: "normal", focused: true, incognito: true }],
      last: { id: 7, type: "normal", incognito: true },
      expected: null,
    },
  ])("current selection never picks arbitrary or agent windows: %j", async ({
    windows,
    last,
    expected,
  }) => {
    vi.stubGlobal("chrome", {
      windows: { getAll: vi.fn(async () => windows), getLastFocused: vi.fn(async () => last) },
    });
    const result = chromeExistingWindowApi.resolveCurrentWindow(new Set([99]));
    if (expected === null) await expect(result).rejects.toThrow("No current normal user window");
    else expect(await result).toBe(expected);
  });
  it("refuses another session's dedicated Agent Window", async () => {
    const f = fixture();
    await f.manager.start("dedicated");
    await expect(f.manager.start("shared", { windowId: 99 })).rejects.toThrow("Window already");
    expect(f.existingWindow.get).not.toHaveBeenCalled();
  });
  it("never automatically claims popup or routes foreign tabs out of a shared window", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    const api = {
      tabs: {
        onCreated: event(),
        onAttached: event(),
        onUpdated: event(),
        onRemoved: event(),
        onDetached: event(),
        query: f.query,
        get: f.tabs.get,
        move: f.tabs.move,
      },
      windows: {
        onFocusChanged: event(),
        onRemoved: event(),
        getAll: vi.fn(async () => []),
        create: vi.fn(),
      },
      webNavigation: { onCreatedNavigationTarget: event() },
    };
    vi.stubGlobal("chrome", api);
    await withTaskPopups(f.manager, { session_id: "a" }, async (sent) => {
      sent(20);
    });
    expect(api.webNavigation.onCreatedNavigationTarget.addListener).not.toHaveBeenCalled();
    const routing = new AgentWindowRouting(
      f.manager,
      api as unknown as Pick<typeof chrome, "tabs" | "windows" | "webNavigation">,
    );
    routing.sync();
    await Promise.resolve();
    await Promise.resolve();
    routing.dispose();
    expect(f.tabs.move).not.toHaveBeenCalled();
    expect(api.windows.create).not.toHaveBeenCalled();
    expect(isAgentControlledTab(ctx, 10)).toBe(false);
  });
});

describe("shared-window cancellation and default-target recovery", () => {
  it("reports a retained task page when session startup is cancelled after creation", async () => {
    const f = fixture();
    const ac = new AbortController();
    f.existingWindow.createTaskTab.mockImplementationOnce(async () => {
      ac.abort();
      return 20;
    });
    expect(
      await handleSessionStart(f.manager, { session_id: "a", window_id: 7 }, { signal: ac.signal }),
    ).toMatchObject({
      code: "cancelled",
      data: { resource_type: "tab", resource_id: 20, window_id: 7, resource_state: "released" },
    });
    expect(f.manager.get("a")).toBeNull();
    expect(f.agentWindow.remove).not.toHaveBeenCalled();
  });
  it("does not delete a shared window's possibly last tab when tab creation is cancelled", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    const ac = new AbortController();
    vi.mocked(f.tabs.create).mockImplementationOnce(async (props) => {
      ac.abort();
      return { ...props, id: 30 } as chrome.tabs.Tab;
    });
    expect(
      await handleTabCreate(f.manager, { session_id: "a" }, { ...f.deps, signal: ac.signal }),
    ).toMatchObject({
      code: "cancelled",
      data: { resource_id: 30, resource_state: "released" },
    });
    expect(f.tabs.remove).not.toHaveBeenCalled();
    expect(ctx.agentCreatedTabs.has(30)).toBe(false);
    expect(ctx.defaultTabId).toBe(20);
  });
  it("releases instead of deleting a page when background setup fails", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    expect(
      await handleTabCreate(
        f.manager,
        { session_id: "a" },
        {
          ...f.deps,
          cdp: {
            ...f.deps.cdp,
            acquireBackgroundExecution: async () => {
              throw new Error("setup failed");
            },
          },
        },
      ),
    ).toMatchObject({
      code: "cdp_failed",
      data: { resource_id: 30, resource_state: "released" },
    });
    expect(f.tabs.remove).not.toHaveBeenCalled();
    expect(ctx.agentCreatedTabs.has(30)).toBe(false);
  });
  it("falls back only to another owned page after the default task page closes", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    await handleTabCreate(f.manager, { session_id: "a" }, f.deps);
    f.manager.forgetClosedTab(20);
    expect(ctx.defaultTabId).toBe(30);
    f.manager.forgetClosedTab(30);
    expect(ctx.defaultTabId).toBeUndefined();
    expect(
      await resolveTargetTab(f.manager, ctx, undefined, { get: f.tabs.get, query: f.query }),
    ).toMatchObject({ code: "not_found" });
    expect(f.query).not.toHaveBeenCalled();
  });
});
