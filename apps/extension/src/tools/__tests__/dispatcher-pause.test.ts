import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame, RequestFrame, RpcError } from "@/transport/types";
import { ToolDispatcher } from "../dispatcher";

async function fixture() {
  let handler: FrameHandler = () => {};
  const sent: ProtocolFrame[] = [];
  const transport = {
    send: (frame: ProtocolFrame) => sent.push(frame),
    onMessage: (listener: FrameHandler) => {
      handler = listener;
      return { dispose: () => {} };
    },
    disconnect: async () => {},
  } as unknown as Transport;
  const create = vi.fn(async () => ({ windowId: 42, initialTabIds: [7] }));
  const sessions = new SessionManager({
    agentWindow: { create, remove: async () => {}, ensureActiveTab: async () => 7 },
  });
  const ctx = await sessions.start("test");
  const resumed = vi.fn();
  const dispatcher = new ToolDispatcher({ transport, sessions, onBrowserControlResumed: resumed });
  dispatcher.start();
  let nextId = 0;
  const deliver = (method: string, params: object = {}) => {
    const id = `pause-${++nextId}`;
    handler({ id, method, params: { session_id: "test", ...params } });
    return id;
  };
  const reply = async (id: string) => {
    await vi.waitFor(() =>
      expect(sent.some((frame) => "id" in frame && frame.id === id)).toBe(true),
    );
    return sent.find((frame) => "id" in frame && frame.id === id) as {
      error?: RpcError;
      result?: unknown;
    };
  };
  return { dispatcher, sessions, ctx, create, resumed, deliver, reply };
}

describe("persistent local interruption", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks repeated inputs, hover observation, evaluation and unknown tools until explicit resume", async () => {
    const f = await fixture();
    expect(f.dispatcher.interruptSession("test")).toBe(true);
    for (const method of [
      "tool.click",
      "tool.click",
      "tool.observe",
      "tool.evaluate",
      "tool.screenshot_full_page",
      "tool.new_mutator",
    ]) {
      expect((await f.reply(f.deliver(method))).error?.code).toBe("user_aborted");
      expect(f.dispatcher.isSessionPaused("test")).toBe(true);
    }
    expect(f.resumed).not.toHaveBeenCalled();
    expect((await f.reply(f.deliver("tool.session_resume"))).result).toMatchObject({
      resumed: true,
    });
    expect(f.dispatcher.isSessionPaused("test")).toBe(false);
    expect(f.sessions.get("test")).toBe(f.ctx);
    expect(f.ctx.agentWindowId).toBe(42);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.resumed).toHaveBeenCalledOnce();
    f.dispatcher.stop();
  });

  it("still allows tab listing and does not consume the pause", async () => {
    vi.stubGlobal("chrome", {
      tabs: { query: async () => [{ id: 7, windowId: 42, active: true }] },
    });
    const f = await fixture();
    f.dispatcher.interruptSession("test");
    expect((await f.reply(f.deliver("tool.tab_list"))).error).toBeUndefined();
    expect(f.dispatcher.isSessionPaused("test")).toBe(true);
    f.dispatcher.stop();
  });

  it("does not resume while an interrupted handler is still cleaning up", async () => {
    const f = await fixture();
    let complete!: (value: object) => void;
    const entered = vi.fn();
    const internal = f.dispatcher as unknown as {
      invoke(req: RequestFrame, signal: AbortSignal): Promise<unknown>;
    };
    const invoke = internal.invoke.bind(f.dispatcher);
    vi.spyOn(internal, "invoke").mockImplementation((req, signal) => {
      if (req.method !== "tool.navigate") return invoke(req, signal);
      entered();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const oldId = f.deliver("tool.navigate");
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    f.dispatcher.interruptSession("test");
    expect([...f.dispatcher.inflightAbortControllers.values()][0].signal.aborted).toBe(true);
    expect((await f.reply(f.deliver("tool.session_resume"))).error?.data).toMatchObject({
      reason: "session_busy",
    });
    expect(f.dispatcher.isSessionPaused("test")).toBe(true);
    complete({ finished: true });
    await f.reply(oldId);
    expect((await f.reply(f.deliver("tool.session_resume"))).result).toMatchObject({
      resumed: true,
    });
    f.dispatcher.stop();
  });

  it("keeps a newer Interrupt paused when it races with resume cleanup", async () => {
    const f = await fixture();
    f.dispatcher.interruptSession("test");
    let complete!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const internal = f.dispatcher as unknown as { releaseHoverLatch(id?: string): Promise<void> };
    const release = vi.spyOn(internal, "releaseHoverLatch").mockReturnValue(cleanup);
    const resumeId = f.deliver("tool.session_resume");
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    f.dispatcher.interruptSession("test");
    complete();
    expect((await f.reply(resumeId)).error?.code).toBe("user_aborted");
    expect(f.dispatcher.isSessionPaused("test")).toBe(true);
    expect(f.resumed).not.toHaveBeenCalled();
    f.dispatcher.stop();
  });

  it("cannot revive a stopped session or pause another context with the same ID", async () => {
    const f = await fixture();
    f.dispatcher.interruptSession("test");
    await f.sessions.stop("test", { dropOnly: true });
    expect((await f.reply(f.deliver("tool.session_resume"))).error?.code).toBe("not_found");
    await f.sessions.start("test");
    expect(f.dispatcher.isSessionPaused("test")).toBe(false);
    f.dispatcher.stop();
  });
});
