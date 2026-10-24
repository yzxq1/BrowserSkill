import { AGENT_WINDOW_HOME, type AgentWindowApi, chromeAgentWindowApi } from "./agent-window";
import { chromeExistingWindowApi, type ExistingWindowApi } from "./existing-window";
import { RefStore } from "./ref-store";
import { type Bsk2TabGroupApi, chromeBsk2TabGroupApi } from "./tab-group";

export interface SessionContext {
  existingWindow?: boolean;
  /** Chrome tab group used only as a visual boundary for this shared-window session. */
  tabGroupId?: number;
  defaultTabId?: number;
  /** Incognito sessions cannot borrow user tabs. Absent means a normal window. */
  incognito?: boolean;
  /** Remote connections retain dedicated windows, with explicit page ownership. */
  remote?: boolean;
  sessionId: string;
  agentWindowId: number;
  refStore: RefStore;
  borrowedTabs: Map<number, BorrowedTab>;
  /**
   * Tabs explicitly claimed by the agent because it created them. This
   * includes the Agent Window's home tab and tabs created by `tool.tab_create`.
   * Tabs opened through Chrome UI never enter this set.
   */
  agentCreatedTabs: Set<number>;
  /** Observed same-window popups: controllable, but preserved by session stop. */
  observedTabs?: Set<number>;
  /**
   * Subset of `observedTabs` the user handed over by dragging them into this
   * session's BSK2 tab group. Dragging them out of the group releases them.
   */
  groupClaimedTabs?: Set<number>;
  /** Unclassified arrivals and failed external moves must not become implicit tool targets. */
  pendingRoutingTabs?: Set<number>;
  createdAtMs: number;
}

/** Whether this session has explicitly claimed control of `tabId`. */
export function isAgentControlledTab(ctx: SessionContext, tabId: number): boolean {
  return (
    ctx.agentCreatedTabs.has(tabId) ||
    ctx.borrowedTabs.has(tabId) ||
    (ctx.observedTabs?.has(tabId) ?? false)
  );
}

export interface BorrowedTab {
  tabId: number;
  originalWindowId: number;
  originalIndex: number;
}

export interface BorrowReservation {
  release(): void;
  commit(entry: BorrowedTab): void;
}

export interface SessionManagerOptions {
  remote?: () => boolean;
  agentWindow?: AgentWindowApi;
  existingWindow?: ExistingWindowApi;
  tabGroups?: Bsk2TabGroupApi;
  now?: () => number;
}

/** Options for starting a session's Agent Window. */
export interface SessionStartOptions {
  windowId?: number;
  /** Use Chrome's shared incognito browsing session. */
  incognito?: boolean;
  /** Optional Agent Window outer size in CSS pixels. */
  size?: { width: number; height: number };
  /** Background by default; true explicitly opens the window in front. */
  focused?: boolean;
  /** Cancellation for the transactional Agent Window startup sequence. */
  signal?: AbortSignal;
}

export class SessionStartCleanupError extends Error {
  readonly windowId: number;
  readonly startupError: unknown;
  readonly cleanupError: unknown;

  constructor(windowId: number, startupError: unknown, cleanupError: unknown) {
    const startupMessage =
      startupError instanceof Error ? startupError.message : String(startupError);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(
      `session_start failed (${startupMessage}) and cleanup of Agent Window ${windowId} failed: ${cleanupMessage}`,
    );
    this.name = "SessionStartCleanupError";
    this.windowId = windowId;
    this.startupError = startupError;
    this.cleanupError = cleanupError;
  }
}

function sessionStartAbortError(): Error {
  const error = new Error("session_start aborted");
  error.name = "AbortError";
  return error;
}

function throwIfSessionStartAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw sessionStartAbortError();
}

/**
 * Owner of all live agent sessions inside the extension.
 *
 * The daemon side has its own `SessionRegistry`; this class is the
 * extension-side mirror that holds the per-session Agent Window id,
 * ref-store, and borrowed-tab table. Tool implementations (M6+) read
 * from here to map a `session_id` back to "which Chrome window /
 * which ref / which borrowed tab".
 *
 * Designed to be unit-testable: chrome.* is injected via `AgentWindowApi`
 * so vitest never touches a real `chrome.windows` object.
 */
export class SessionManager {
  private readonly remote: () => boolean;
  private readonly sessions = new Map<string, SessionContext>();
  private readonly windowIndex = new Map<number, string>();
  private readonly borrowReservations = new Map<number, string>();
  private readonly startingSessions = new Set<string>();
  private readonly windowReservations = new Map<number, string>();
  private readonly existingWindow: ExistingWindowApi;
  private readonly tabGroups: Bsk2TabGroupApi;
  private readonly expectedWindowClosures = new WeakSet<SessionContext>();
  private readonly agentWindow: AgentWindowApi;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.existingWindow = options.existingWindow ?? chromeExistingWindowApi;
    this.tabGroups = options.tabGroups ?? chromeBsk2TabGroupApi;
    this.remote = options.remote ?? (() => false);
    this.agentWindow = options.agentWindow ?? chromeAgentWindowApi;
    this.now = options.now ?? Date.now;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionContext | null {
    return this.sessions.get(sessionId) ?? null;
  }

  isWindowCloseExpected(ctx: SessionContext): boolean {
    return this.expectedWindowClosures.has(ctx);
  }

  /** Mark only the committed window/tab removal stage of session.stop. */
  async withExpectedWindowClose<T>(ctx: SessionContext, close: () => Promise<T>): Promise<T> {
    this.expectedWindowClosures.add(ctx);
    try {
      return await close();
    } finally {
      // Failed teardown must not hide a later user-initiated close.
      this.expectedWindowClosures.delete(ctx);
    }
  }

  findByWindowId(windowId: number): SessionContext | null {
    const id = this.windowIndex.get(windowId);
    return id ? (this.sessions.get(id) ?? null) : null;
  }

  /** Add an explicitly authorised shared-window tab to this session's visual group. */
  async groupControlledTab(ctx: SessionContext, tabId: number): Promise<void> {
    if (!ctx.existingWindow) return;
    if (ctx.tabGroupId !== undefined) {
      try {
        await this.tabGroups.add(ctx.tabGroupId, tabId);
        return;
      } catch {
        // The user may have manually removed the group. Recreate one from the
        // concrete authorised tab; never search for or claim a same-named group.
      }
    }
    ctx.tabGroupId = await this.tabGroups.create(tabId);
    await this.tabGroups.remember(ctx.agentWindowId, ctx.tabGroupId).catch(() => {});
  }

  /**
   * Join the window's persistent BSK2 group, or create it. Returns the group id
   * plus the tabs that were already inside a reused group: the user left them in
   * the agent area, which is the same consent as dragging them in.
   */
  private async joinBsk2Group(
    windowId: number,
    taskTabId: number,
  ): Promise<{ groupId: number; adopted: number[] }> {
    const remembered = await this.tabGroups.recall(windowId).catch(() => undefined);
    if (remembered !== undefined) {
      try {
        const before = await this.tabGroups.members(remembered);
        await this.tabGroups.add(remembered, taskTabId);
        const others = new Set(
          [...this.sessions.values()].flatMap((other) => [
            ...other.agentCreatedTabs,
            ...other.borrowedTabs.keys(),
            ...(other.observedTabs ?? []),
          ]),
        );
        return {
          groupId: remembered,
          adopted: before.filter((id) => id !== taskTabId && !others.has(id)),
        };
      } catch {
        // Fall through and create a fresh group.
      }
    }
    const groupId = await this.tabGroups.create(taskTabId);
    await this.tabGroups.remember(windowId, groupId).catch(() => {});
    return { groupId, adopted: [] };
  }

  /** Release visual grouping without changing the tab's control/ownership state. */
  async ungroupControlledTab(ctx: SessionContext, tabId: number): Promise<void> {
    if (!ctx.existingWindow || ctx.tabGroupId === undefined) return;
    try {
      await this.tabGroups.remove(tabId);
    } catch {
      // A user may have already ungrouped or closed the tab. Cleanup remains best-effort.
    }
  }

  /** Remove every still-controlled tab from the BSK2 group before releasing a shared window. */
  async ungroupControlledTabs(ctx: SessionContext, tabIds: Iterable<number>): Promise<void> {
    if (!ctx.existingWindow || ctx.tabGroupId === undefined) return;
    for (const tabId of tabIds) await this.ungroupControlledTab(ctx, tabId);
    ctx.tabGroupId = undefined;
  }

  list(): SessionContext[] {
    return Array.from(this.sessions.values());
  }

  invalidateTabRefs(tabId: number): void {
    for (const ctx of this.sessions.values()) ctx.refStore.invalidateTab(tabId);
  }

  /**
   * Forget a tab Chrome has removed, including any uncommitted borrow.
   * Whole-window closures keep committed borrows until the window-removed
   * handler reports which user tabs could not be returned.
   */
  forgetClosedTab(tabId: number, { isWindowClosing = false } = {}): void {
    this.borrowReservations.delete(tabId);
    this.invalidateTabRefs(tabId);
    for (const ctx of this.sessions.values()) {
      ctx.agentCreatedTabs.delete(tabId);
      ctx.observedTabs?.delete(tabId);
      ctx.groupClaimedTabs?.delete(tabId);
      if (!isWindowClosing) ctx.borrowedTabs.delete(tabId);
      if (ctx.existingWindow && ctx.defaultTabId === tabId) {
        ctx.defaultTabId =
          ctx.agentCreatedTabs.values().next().value ?? ctx.borrowedTabs.keys().next().value;
      }
    }
  }

  /** All kinds of committed control, not just borrowed tabs. */
  findControllingSession(tabId: number): string | null {
    return this.list().find((ctx) => isAgentControlledTab(ctx, tabId))?.sessionId ?? null;
  }

  /** Observation does not follow a page moved out by the browser user. */
  releaseObservedTab(tabId: number): string[] {
    const released: string[] = [];
    for (const ctx of this.sessions.values()) {
      if (ctx.observedTabs?.delete(tabId)) {
        ctx.groupClaimedTabs?.delete(tabId);
        ctx.refStore.invalidateTab(tabId);
        released.push(ctx.sessionId);
      }
    }
    return released;
  }

  /**
   * Look up whether `tabId` is currently borrowed by some *other*
   * session than the one calling. Used by M8 `tab_borrow` to refuse
   * a second borrow on the same Chrome tab, and by `tab_close` to
   * tell apart "user tab" from "another session's borrowed tab"
   * (which we must not allow direct access to).
   *
   * Returns the borrowing session id when applicable, otherwise null.
   */
  findBorrowingSession(tabId: number, currentSessionId: string | null): string | null {
    for (const ctx of this.sessions.values()) {
      if (ctx.sessionId === currentSessionId) continue;
      if (ctx.borrowedTabs.has(tabId)) return ctx.sessionId;
    }
    const reservedBy = this.borrowReservations.get(tabId);
    if (reservedBy && reservedBy !== currentSessionId) return reservedBy;
    return null;
  }

  /**
   * Reserve a tab for `tool.tab_borrow` before the handler performs any
   * awaited Chrome work. This closes the cross-session race between the
   * "is anyone borrowing this tab?" check and the eventual borrowedTabs
   * write after `chrome.tabs.move`.
   */
  tryReserveBorrow(tabId: number, sessionId: string): BorrowReservation | { borrowedBy: string } {
    const borrowedBy =
      this.borrowReservations.get(tabId) ??
      this.findControllingSession(tabId) ??
      this.findBorrowingSession(tabId, sessionId);
    if (borrowedBy) return { borrowedBy };
    this.borrowReservations.set(tabId, sessionId);
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      if (this.borrowReservations.get(tabId) === sessionId) {
        this.borrowReservations.delete(tabId);
      }
    };
    return {
      release,
      commit: (entry) => {
        if (closed) return;
        const ctx = this.sessions.get(sessionId);
        if (!ctx) {
          release();
          throw new Error(`session ${sessionId} disappeared during tab_borrow`);
        }
        if (this.borrowReservations.get(tabId) !== sessionId) {
          throw new Error(`tab ${tabId} borrow reservation disappeared before commit`);
        }
        ctx.borrowedTabs.set(tabId, entry);
        release();
      },
    };
  }

  /**
   * Spin up a fresh session: open a new Agent Window with an
   * `about:blank` tab and register the context.
   *
   * Returns the created window id so callers can echo it back to the
   * daemon in the `tool.session_start` reply.
   */
  async start(sessionId: string, opts: SessionStartOptions = {}): Promise<SessionContext> {
    if (this.sessions.has(sessionId) || this.startingSessions.has(sessionId)) {
      throw new Error(`[bh] session ${sessionId} already exists`);
    }
    throwIfSessionStartAborted(opts.signal);

    if (opts.windowId === -1) {
      if (opts.incognito !== undefined || opts.size !== undefined || opts.focused === true) {
        throw new Error("Invalid existing window options");
      }
      this.startingSessions.add(sessionId);
      let resolved: number;
      try {
        resolved = await this.existingWindow.resolveCurrentWindow(
          new Set([...this.windowIndex.keys(), ...this.windowReservations.keys()]),
        );
        if (!Number.isSafeInteger(resolved) || resolved <= 0)
          throw new Error("No current user window available");
      } finally {
        this.startingSessions.delete(sessionId);
      }
      // The numeric path rechecks and synchronously reserves the selected id.
      return this.start(sessionId, { ...opts, windowId: resolved });
    }
    if (opts.windowId !== undefined) {
      if (
        !Number.isSafeInteger(opts.windowId) ||
        opts.windowId <= 0 ||
        opts.incognito !== undefined ||
        opts.size !== undefined ||
        opts.focused === true
      ) {
        throw new Error("Invalid existing window options");
      }
      if (this.windowIndex.has(opts.windowId) || this.windowReservations.has(opts.windowId)) {
        throw new Error("Window already belongs to a session or pending session_start");
      }
      // Reserve synchronously before the first awaited browser call.
      this.windowReservations.set(opts.windowId, sessionId);
    }
    this.startingSessions.add(sessionId);
    let windowId: number | null = null;
    const agentCreatedTabs = new Set<number>();
    try {
      if (opts.windowId !== undefined) {
        const win = await this.existingWindow.get(opts.windowId);
        if (win.id !== opts.windowId || win.type !== "normal" || win.incognito) {
          throw new Error("window_id must identify an existing normal non-incognito window");
        }
        throwIfSessionStartAborted(opts.signal);
        const tabId = await this.existingWindow.createTaskTab(opts.windowId);
        // Cancellation releases authority only; report any retained page rather
        // than removing the user's possibly last tab and implicitly closing it.
        if (opts.signal?.aborted) {
          throw Object.assign(sessionStartAbortError(), {
            releasedTabId: tabId,
            releasedWindowId: opts.windowId,
          });
        }
        let tabGroupId: number;
        let adopted: number[] = [];
        try {
          ({ groupId: tabGroupId, adopted } = await this.joinBsk2Group(opts.windowId, tabId));
        } catch (error) {
          throw new Error(
            `Failed to create the BSK2 tab group for task tab ${tabId}; the tab was left open without task control: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const ctx: SessionContext = {
          existingWindow: true,
          tabGroupId,
          defaultTabId: tabId,
          incognito: false,
          ...(this.remote() ? { remote: true } : {}),
          sessionId,
          agentWindowId: opts.windowId,
          refStore: new RefStore(),
          borrowedTabs: new Map(),
          agentCreatedTabs: new Set([tabId]),
          // Tabs the user left in the persistent BSK2 group stay operable.
          ...(adopted.length > 0
            ? { observedTabs: new Set(adopted), groupClaimedTabs: new Set(adopted) }
            : {}),
          createdAtMs: this.now(),
        };
        this.sessions.set(sessionId, ctx);
        this.windowIndex.set(opts.windowId, sessionId);
        return ctx;
      }
      const { signal: _signal, ...createOptions } = opts;
      const created = await this.agentWindow.create(AGENT_WINDOW_HOME, createOptions);
      windowId = created.windowId;
      for (const tabId of created.initialTabIds) agentCreatedTabs.add(tabId);
      if (opts.incognito && !created.incognito) {
        throw new Error(
          "The browser did not create an incognito Agent Window; session start refused.",
        );
      }
      throwIfSessionStartAborted(opts.signal);
      const homeTabId = await this.agentWindow.ensureActiveTab(
        windowId,
        AGENT_WINDOW_HOME,
        agentCreatedTabs,
      );
      agentCreatedTabs.add(homeTabId);
      throwIfSessionStartAborted(opts.signal);

      const ctx: SessionContext = {
        defaultTabId: homeTabId,
        incognito: created.incognito ?? false,
        ...(this.remote() ? { remote: true } : {}),
        sessionId,
        agentWindowId: windowId,
        refStore: new RefStore(),
        borrowedTabs: new Map(),
        // Capture ownership at creation, before initialization can fail.
        // Later tabs remain free until `tab_create` or `tab_borrow` identifies
        // them by their concrete Chrome tab id.
        agentCreatedTabs,
        createdAtMs: this.now(),
      };
      this.sessions.set(sessionId, ctx);
      this.windowIndex.set(windowId, sessionId);
      return ctx;
    } catch (startupError) {
      if (windowId !== null) {
        try {
          await this.agentWindow.remove(windowId);
        } catch (cleanupError) {
          // The daemon may retry stop after a failed startup rollback. Retain
          // the exact window handle until closure is confirmed.
          const pending: SessionContext = {
            incognito: opts.incognito ?? false,
            ...(this.remote() ? { remote: true } : {}),
            sessionId,
            agentWindowId: windowId,
            refStore: new RefStore(),
            borrowedTabs: new Map(),
            agentCreatedTabs,
            createdAtMs: this.now(),
          };
          this.sessions.set(sessionId, pending);
          this.windowIndex.set(windowId, sessionId);
          throw new SessionStartCleanupError(windowId, startupError, cleanupError);
        }
      }
      throw startupError;
    } finally {
      this.startingSessions.delete(sessionId);
      if (opts.windowId !== undefined && this.windowReservations.get(opts.windowId) === sessionId) {
        this.windowReservations.delete(opts.windowId);
      }
    }
  }

  /**
   * Tear down a session: close its Agent Window and drop the context.
   *
   * `dropOnly = true` skips closing the window — used when the user
   * already closed it manually (M5.4 path) so we don't accidentally
   * close a window that has been re-purposed.
   */
  async stop(
    sessionId: string,
    options: { dropOnly?: boolean } = {},
  ): Promise<SessionContext | null> {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return null;
    if (!options.dropOnly && !ctx.existingWindow) {
      await this.agentWindow.remove(ctx.agentWindowId);
    }
    this.sessions.delete(sessionId);
    this.windowIndex.delete(ctx.agentWindowId);
    if (ctx.existingWindow) {
      ctx.refStore.clear();
      ctx.agentCreatedTabs.clear();
      ctx.borrowedTabs.clear();
      ctx.observedTabs?.clear();
      ctx.groupClaimedTabs?.clear();
      ctx.pendingRoutingTabs?.clear();
      ctx.tabGroupId = undefined;
      ctx.defaultTabId = undefined;
    }
    return ctx;
  }

  /**
   * Best-effort cleanup of every live session (emergency brake / SW
   * shutdown). Returns the set of `session_id`s that were removed.
   */
  async stopAll(options: { dropOnly?: boolean } = {}): Promise<string[]> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.stop(id, options);
    }
    return ids;
  }
}
