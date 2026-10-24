import { isAgentControlledTab, type SessionManager } from "./manager";
import { BSK2_TAB_GROUP_TITLE } from "./tab-group";

/**
 * BSK2 drag-to-authorize.
 *
 * In existing-window mode every tab group in the session's window whose title
 * is exactly `BSK2` is an agent area — the group the extension created, groups
 * the user creates or renames to `BSK2` at any time, and several of them at
 * once. Putting a tab into any such group hands it to the agent; taking it out
 * (or renaming the group to something else) takes it back.
 *
 * Only the user or an extension can create, rename or regroup tabs; a web page
 * cannot, so the user's action in Chrome's tab strip is the authorization.
 * Tabs the agent already controls (created, borrowed, observed popups) are left
 * untouched, so the extension's own grouping calls never re-enter as a claim.
 */
export interface GroupMembershipChange {
  tabId: number;
  /** `chrome.tabs.TAB_GROUP_ID_NONE` (-1) when the tab is in no group. */
  groupId: number;
  /** Title of `groupId`; omitted/empty while Chrome has not named it yet. */
  groupTitle?: string;
  windowId?: number;
  incognito?: boolean;
}

export type GroupMembershipResult =
  | { kind: "claimed"; sessionId: string }
  | { kind: "released"; sessionId: string }
  | null;

export function isBsk2Group(title: string | undefined): boolean {
  return title === BSK2_TAB_GROUP_TITLE;
}

export function applyGroupMembership(
  manager: SessionManager,
  change: GroupMembershipChange,
): GroupMembershipResult {
  const { tabId, groupId } = change;
  const sessionFor = (windowId: number | undefined) =>
    manager
      .list()
      .find((ctx) => ctx.existingWindow && !ctx.incognito && ctx.agentWindowId === windowId);
  const inAgentArea = (ctx: { tabGroupId?: number }) =>
    groupId >= 0 &&
    !change.incognito &&
    // The session's own group counts even before Chrome reports its title.
    (isBsk2Group(change.groupTitle) || groupId === ctx.tabGroupId);

  // Leaving every agent area: release only control granted by being inside one.
  for (const ctx of manager.list()) {
    if (!ctx.groupClaimedTabs?.has(tabId)) continue;
    if (ctx.agentWindowId === change.windowId && inAgentArea(ctx)) return null;
    ctx.groupClaimedTabs.delete(tabId);
    ctx.observedTabs?.delete(tabId);
    ctx.refStore.invalidateTab(tabId);
    if (ctx.defaultTabId === tabId) {
      ctx.defaultTabId =
        ctx.agentCreatedTabs.values().next().value ?? ctx.borrowedTabs.keys().next().value;
    }
    return { kind: "released", sessionId: ctx.sessionId };
  }

  const ctx = sessionFor(change.windowId);
  if (!ctx || !inAgentArea(ctx)) return null;
  if (isAgentControlledTab(ctx, tabId)) return null;
  // Another session's borrow, reservation or control always wins.
  if (manager.findControllingSession(tabId) || manager.findBorrowingSession(tabId, ctx.sessionId))
    return null;
  (ctx.observedTabs ??= new Set()).add(tabId);
  (ctx.groupClaimedTabs ??= new Set()).add(tabId);
  return { kind: "claimed", sessionId: ctx.sessionId };
}

export interface WindowGroupSnapshot {
  windowId: number;
  /** Every tab of the window with its current group (-1 = none). */
  tabs: Array<{ tabId: number; groupId: number; incognito?: boolean }>;
  /** Every tab group of the window. */
  groups: Array<{ groupId: number; title?: string }>;
}

export interface ReconcileResult {
  sessionId: string;
  claimed: number[];
  released: number[];
}

/**
 * Bring a window's group-granted control in line with the tab strip: tabs in
 * any `BSK2` group (or the session's own group) are claimed, group-claimed tabs
 * outside every such group are released. Used for group creation, renaming,
 * dissolving and session start, where per-tab events are not enough.
 */
export function reconcileWindowGroups(
  manager: SessionManager,
  snapshot: WindowGroupSnapshot,
): ReconcileResult | null {
  const ctx = manager
    .list()
    .find(
      (candidate) =>
        candidate.existingWindow &&
        !candidate.incognito &&
        candidate.agentWindowId === snapshot.windowId,
    );
  if (!ctx) return null;
  const areas = new Set(
    snapshot.groups
      .filter((group) => isBsk2Group(group.title) || group.groupId === ctx.tabGroupId)
      .map((group) => group.groupId),
  );
  const inside = new Set(
    snapshot.tabs
      .filter((tab) => !tab.incognito && tab.groupId >= 0 && areas.has(tab.groupId))
      .map((tab) => tab.tabId),
  );
  const result: ReconcileResult = { sessionId: ctx.sessionId, claimed: [], released: [] };
  for (const tabId of [...(ctx.groupClaimedTabs ?? [])]) {
    if (inside.has(tabId)) continue;
    ctx.groupClaimedTabs?.delete(tabId);
    ctx.observedTabs?.delete(tabId);
    ctx.refStore.invalidateTab(tabId);
    if (ctx.defaultTabId === tabId) {
      ctx.defaultTabId =
        ctx.agentCreatedTabs.values().next().value ?? ctx.borrowedTabs.keys().next().value;
    }
    result.released.push(tabId);
  }
  for (const tabId of inside) {
    if (isAgentControlledTab(ctx, tabId)) continue;
    if (manager.findControllingSession(tabId) || manager.findBorrowingSession(tabId, ctx.sessionId))
      continue;
    (ctx.observedTabs ??= new Set()).add(tabId);
    (ctx.groupClaimedTabs ??= new Set()).add(tabId);
    result.claimed.push(tabId);
  }
  return result;
}
