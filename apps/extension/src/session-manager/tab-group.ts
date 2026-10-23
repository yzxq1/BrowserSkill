/** Visual-only grouping for tabs explicitly controlled by an existing-window session. */
export const BSK2_TAB_GROUP_TITLE = "BSK2";

/**
 * Small injectable surface over Chrome's tabGroups API.  A group is a UI aid,
 * never evidence that a tab is authorised for automation.
 */
export interface Bsk2TabGroupApi {
  create(tabId: number): Promise<number>;
  add(groupId: number, tabId: number): Promise<void>;
  remove(tabId: number): Promise<void>;
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
};
