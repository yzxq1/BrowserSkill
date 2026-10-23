import { describe, expect, it, vi } from "vitest";
import { handleSessionStop } from "@/tools/session";
import { applyGroupMembership } from "../group-membership";
import { isAgentControlledTab, SessionManager } from "../manager";

function fixture() {
  let nextGroup = 70;
  const tabGroups = {
    create: vi.fn(async () => nextGroup++),
    add: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
  const existingWindow = {
    resolveCurrentWindow: vi.fn(async () => 7),
    get: vi.fn(
      async (id: number) => ({ id, type: "normal", incognito: false }) as chrome.windows.Window,
    ),
    createTaskTab: vi.fn(async (windowId: number) => (windowId === 7 ? 20 : 21)),
  };
  const agentWindow = {
    create: vi.fn(async () => ({ windowId: 99, initialTabIds: [990] })),
    ensureActiveTab: vi.fn(async () => 990),
    remove: vi.fn(async () => {}),
  };
  const manager = new SessionManager({ agentWindow, existingWindow, tabGroups });
  return { manager, tabGroups };
}

describe("BSK2 drag-to-authorize", () => {
  it("dragging a user tab into the session's BSK2 group grants control; dragging out releases it", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    expect(ctx.tabGroupId).toBe(70);
    expect(isAgentControlledTab(ctx, 10)).toBe(false);

    expect(applyGroupMembership(f.manager, { tabId: 10, groupId: 70, windowId: 7 })).toEqual({
      kind: "claimed",
      sessionId: "a",
    });
    expect(isAgentControlledTab(ctx, 10)).toBe(true);
    // Granted as a non-destructive claim: stop/auto-close never closes it.
    expect(ctx.agentCreatedTabs.has(10)).toBe(false);
    // Repeated events while it stays in the group change nothing.
    expect(applyGroupMembership(f.manager, { tabId: 10, groupId: 70, windowId: 7 })).toBeNull();

    ctx.defaultTabId = 10;
    expect(applyGroupMembership(f.manager, { tabId: 10, groupId: -1, windowId: 7 })).toEqual({
      kind: "released",
      sessionId: "a",
    });
    expect(isAgentControlledTab(ctx, 10)).toBe(false);
    expect(ctx.defaultTabId).toBe(20);
  });

  it("ignores user-made groups, other windows, incognito, and tabs another session controls", async () => {
    const f = fixture();
    const a = await f.manager.start("a", { windowId: 7 });
    const b = await f.manager.start("b", { windowId: 8 });
    expect(applyGroupMembership(f.manager, { tabId: 10, groupId: 999, windowId: 7 })).toBeNull();
    expect(applyGroupMembership(f.manager, { tabId: 10, groupId: 70, windowId: 8 })).toBeNull();
    expect(
      applyGroupMembership(f.manager, { tabId: 10, groupId: 70, windowId: 7, incognito: true }),
    ).toBeNull();
    // Session b's own task tab dragged into a's group stays with b.
    expect(
      applyGroupMembership(f.manager, { tabId: 21, groupId: a.tabGroupId!, windowId: 7 }),
    ).toBeNull();
    expect(isAgentControlledTab(a, 21)).toBe(false);
    expect(isAgentControlledTab(b, 21)).toBe(true);
    expect(isAgentControlledTab(a, 10)).toBe(false);
  });

  it("does not release tabs the agent created or borrowed when they leave the group", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    expect(applyGroupMembership(f.manager, { tabId: 20, groupId: -1, windowId: 7 })).toBeNull();
    expect(isAgentControlledTab(ctx, 20)).toBe(true);
  });

  it("session stop releases group-claimed tabs without closing them", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { windowId: 7 });
    applyGroupMembership(f.manager, { tabId: 10, groupId: 70, windowId: 7 });
    const remove = vi.fn(async () => {});
    const result = await handleSessionStop(
      f.manager,
      { session_id: "a" },
      {
        agentPreferences: {
          ready: async () => {},
          get: () => ({ windowStrategy: "existing", autoCloseTabs: true }),
        },
        tabManagement: {
          tabs: { remove } as never,
          agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
        },
        cdp: { releaseSessionTab: vi.fn(async () => {}), detachSession: vi.fn(async () => {}) },
      },
    );
    expect(result).toMatchObject({ window_released: true });
    // Auto-close only touches the task's own tab, never the user's dragged-in tab.
    expect(remove).toHaveBeenCalledWith(20);
    expect(remove).not.toHaveBeenCalledWith(10);
    expect(f.tabGroups.remove).toHaveBeenCalledWith(10);
    expect(isAgentControlledTab(ctx, 10)).toBe(false);
    expect(f.manager.get("a")).toBeNull();
  });
});
