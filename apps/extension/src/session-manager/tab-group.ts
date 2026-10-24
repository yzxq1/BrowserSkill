/** Visual-and-consent grouping for tabs controlled by an existing-window session. */
export const BSK2_TAB_GROUP_TITLE = "BSK2";

/** chrome.storage.session key: `{ [windowId]: groupId }` of BSK2-created groups. */
export const BSK2_GROUP_STORAGE_KEY = "bsk2_tab_groups";

/**
 * Small injectable surface over Chrome's tabGroups API.
 *
 * The BSK2 group outlives a session: stop leaves it (and its tabs) in place so
 * the user keeps a stable "agent area" in the window. The next existing-window
 * session in that window reuses the remembered group.
 *
 * After a browser restart Chrome restores groups with new ids and
 * `storage.session` is cleared, so the window's group titled exactly "BSK2" is
 * adopted instead of creating a duplicate. Web pages cannot create or rename
 * tab groups; only the user or an extension can, and the user treats this group
 * as the agent area by design.
 */
export interface Bsk2TabGroupApi {
  create(tabId: number): Promise<number>;
  add(groupId: number, tabId: number): Promise<void>;
  remove(tabId: number): Promise<void>;
  /** Remember the BSK2 group created in `windowId` (browser-session lifetime). */
  remember(windowId: number, groupId: number): Promise<void>;
  /** The remembered BSK2 group of `windowId`, if it still exists in that window. */
  recall(windowId: number): Promise<number | undefined>;
  /** Tab ids currently inside `groupId`. */
  members(groupId: number): Promise<number[]>;
}

type GroupMap = Record<string, number>;

async function readGroups(): Promise<GroupMap> {
  const area = globalThis.chrome?.storage?.session;
  if (!area) return {};
  try {
    const stored = await area.get(BSK2_GROUP_STORAGE_KEY);
    const value = stored[BSK2_GROUP_STORAGE_KEY];
    return value && typeof value === "object" ? (value as GroupMap) : {};
  } catch {
    return {};
  }
}

async function writeGroups(groups: GroupMap): Promise<void> {
  const area = globalThis.chrome?.storage?.session;
  if (!area) return;
  try {
    await area.set({ [BSK2_GROUP_STORAGE_KEY]: groups });
  } catch {
    /* Remembering the group is a convenience; a fresh group still works. */
  }
}

export const chromeBsk2TabGroupApi: Bsk2TabGroupApi = {
  async create(tabId) {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: BSK2_TAB_GROUP_TITLE,
      color: "blue",
      collapsed: false,
    });
    return groupId;
  },
  async add(groupId, tabId) {
    await chrome.tabs.group({ groupId, tabIds: [tabId] });
  },
  async remove(tabId) {
    await chrome.tabs.ungroup(tabId);
  },
  async remember(windowId, groupId) {
    const groups = await readGroups();
    groups[String(windowId)] = groupId;
    await writeGroups(groups);
  },
  async recall(windowId) {
    const groups = await readGroups();
    const groupId = groups[String(windowId)];
    if (typeof groupId === "number") {
      try {
        const group = await chrome.tabGroups.get(groupId);
        if (group.windowId === windowId) return groupId;
      } catch {
        /* The user dissolved or closed the group. */
      }
    }
    // Browser restart: adopt the restored BSK2 group of this window.
    let restored: number | undefined;
    try {
      const found = await chrome.tabGroups.query({ windowId, title: BSK2_TAB_GROUP_TITLE });
      restored = found.find((group) => group.title === BSK2_TAB_GROUP_TITLE)?.id;
    } catch {
      restored = undefined;
    }
    if (restored === undefined) delete groups[String(windowId)];
    else groups[String(windowId)] = restored;
    await writeGroups(groups);
    return restored;
  },
  async members(groupId) {
    const tabs = await chrome.tabs.query({ groupId });
    return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === "number");
  },
};
