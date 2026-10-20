/** Existing user windows are never created, activated, resized or removed here. */
export interface ExistingWindowApi {
  get(windowId: number): Promise<chrome.windows.Window>;
  resolveCurrentWindow(excludedWindowIds: ReadonlySet<number>): Promise<number>;
  createTaskTab(windowId: number): Promise<number>;
}

export const chromeExistingWindowApi: ExistingWindowApi = {
  get: (windowId) => chrome.windows.get(windowId),
  async resolveCurrentWindow(excludedWindowIds) {
    const eligible = (win: chrome.windows.Window) =>
      typeof win.id === "number" && win.type === "normal" && !win.incognito && !excludedWindowIds.has(win.id);
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const focused = windows.find((win) => win.focused && eligible(win));
    if (focused?.id !== undefined) return focused.id;
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (eligible(last)) return last.id!;
    throw new Error("No current normal user window is available; specify a window_id explicitly");
  },
  async createTaskTab(windowId) {
    const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false, index: -1 });
    if (typeof tab.id !== "number") throw new Error("chrome.tabs.create returned no task tab id");
    return tab.id;
  },
};
