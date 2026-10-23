import { isAgentControlledTab, type SessionManager } from "./manager";

/**
 * BSK2 drag-to-authorize.
 *
 * In existing-window mode the user can drag any normal tab of the session's
 * window into that session's own `BSK2` tab group to hand it to the agent, and
 * drag it back out to take it away again. The user's drag in Chrome's tab strip
 * is the explicit authorization; a web page cannot move tabs between groups.
 *
 * Only the concrete group id this session created counts — a user-made group
 * that happens to be titled "BSK2" never grants anything. Tabs the agent
 * already controls (created, borrowed, observed popups) are left untouched, so
 * the extension's own grouping calls never re-enter here as a new claim.
 */
export interface GroupMembershipChange {
  tabId: number;
  /** `chrome.tabs.TAB_GROUP_ID_NONE` (-1) when the tab left every group. */
  groupId: number;
  windowId?: number;
  incognito?: boolean;
}

export type GroupMembershipResult =
  | { kind: "claimed"; sessionId: string }
  | { kind: "released"; sessionId: string }
  | null;

export function applyGroupMembership(
  manager: SessionManager,
  change: GroupMembershipChange,
): GroupMembershipResult {
  const { tabId, groupId } = change;
  // Leaving the group: release only control that was granted by joining it.
  for (const ctx of manager.list()) {
    if (!ctx.groupClaimedTabs?.has(tabId)) continue;
    if (ctx.tabGroupId !== undefined && groupId === ctx.tabGroupId) return null;
    ctx.groupClaimedTabs.delete(tabId);
    ctx.observedTabs?.delete(tabId);
    ctx.refStore.invalidateTab(tabId);
    if (ctx.defaultTabId === tabId) {
      ctx.defaultTabId =
        ctx.agentCreatedTabs.values().next().value ?? ctx.borrowedTabs.keys().next().value;
    }
    return { kind: "released", sessionId: ctx.sessionId };
  }
  if (groupId < 0 || change.incognito) return null;
  const ctx = manager
    .list()
    .find((candidate) => candidate.existingWindow && candidate.tabGroupId === groupId);
  if (!ctx || ctx.incognito) return null;
  if (change.windowId !== undefined && change.windowId !== ctx.agentWindowId) return null;
  if (isAgentControlledTab(ctx, tabId)) return null;
  // Another session's borrow, reservation or control always wins.
  if (manager.findControllingSession(tabId) || manager.findBorrowingSession(tabId, ctx.sessionId))
    return null;
  (ctx.observedTabs ??= new Set()).add(tabId);
  (ctx.groupClaimedTabs ??= new Set()).add(tabId);
  return { kind: "claimed", sessionId: ctx.sessionId };
}
