import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { SessionControlBridge } from "../session-control-bridge";
import { SESSION_CONTROL_MESSAGE } from "../session-control-client";

async function fixture() {
  vi.stubGlobal("chrome", {
    runtime: { id: "self", getURL: (p: string) => `chrome-extension://self${p}` },
  });
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 42, initialTabIds: [7] }),
      ensureActiveTab: async () => 7,
      remove: async () => {},
    },
  });
  const ctx = await sessions.start("one");
  const handlers = new Set<FrameHandler>(),
    sent: ProtocolFrame[] = [];
  const transport = {
    state: "connected",
    send: (frame: ProtocolFrame) => sent.push(frame),
    onMessage: (fn: FrameHandler) => {
      handlers.add(fn);
      return { dispose: () => handlers.delete(fn) };
    },
    onConnectionStateChange: () => ({ dispose: () => {} }),
  } as unknown as Transport;
  let paused = true;
  const dispatcher = {
    isSessionPaused: () => paused,
    interruptSession: vi.fn(() => {
      paused = true;
      return true;
    }),
  };
  const onPaused = vi.fn(),
    onResumed = vi.fn();
  const bridge = new SessionControlBridge({ sessions, dispatcher, transport, onPaused, onResumed });
  const content = {
    id: "self",
    frameId: 0,
    tab: { id: 7, windowId: 42 },
  } as chrome.runtime.MessageSender;
  const popup = { id: "self", url: "chrome-extension://self/popup.html" };
  const message = { kind: SESSION_CONTROL_MESSAGE, action: "resume", sessionId: "one" };
  const reply = (success = true) => {
    const id = (sent.find((frame) => "method" in frame) as { id: string }).id;
    if (success) paused = false;
    for (const fn of handlers)
      fn(
        success
          ? { id, result: { resumed: true } }
          : { id, error: { code: "timeout", message: "busy", data: { reason: "session_busy" } } },
      );
  };
  return {
    sessions,
    ctx,
    bridge,
    content,
    popup,
    message,
    sent,
    reply,
    dispatcher,
    onPaused,
    onResumed,
    setPaused: (v: boolean) => {
      paused = v;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("trusted page/popup resume bridge", () => {
  it("resumes an owned top-frame task only after both sides confirm", async () => {
    const f = await fixture();
    const work = f.bridge.handle(f.message, f.content);
    expect(f.bridge.isResuming("one")).toBe(true);
    expect(f.onResumed).not.toHaveBeenCalled();
    f.reply();
    expect(await work).toEqual({ ok: true });
    expect(f.onResumed).toHaveBeenCalledWith("one");
    expect(f.bridge.isResuming("one")).toBe(false);
    expect(f.sessions.get("one")).toBe(f.ctx);
  });
  it.each([
    { id: "other", frameId: 0, tab: { id: 7, windowId: 42 } },
    { id: "self", frameId: 1, tab: { id: 7, windowId: 42 } },
    { id: "self", frameId: 0, tab: { id: 8, windowId: 42 } },
    { id: "self", frameId: 0, tab: { id: 7, windowId: 99 } },
    { id: "self", url: "chrome-extension://self/debug.html" },
    { id: "self", url: "https://self/popup.html" },
  ])("rejects free tabs, foreign origins and child frames: %j", async (sender) => {
    const f = await fixture();
    expect(await f.bridge.handle(f.message, sender as chrome.runtime.MessageSender)).toEqual({
      ok: false,
      error: "failed",
    });
    expect(f.sent).toHaveLength(0);
  });
  it("lists paused tasks only in the real popup and deduplicates double clicks", async () => {
    const f = await fixture();
    const list = { kind: SESSION_CONTROL_MESSAGE, action: "list" };
    expect(await f.bridge.handle(list, f.content)).toEqual({ ok: false, error: "failed" });
    const first = f.bridge.handle(f.message, f.popup),
      second = f.bridge.handle(f.message, f.content);
    expect(f.sent).toHaveLength(1);
    f.setPaused(false); // extension ack came first; daemon has not yet confirmed
    expect(await f.bridge.handle(list, f.popup)).toEqual({
      ok: true,
      tasks: [{ sessionId: "one", resuming: true }],
    });
    expect(f.onResumed).not.toHaveBeenCalled();
    f.reply();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    expect(f.onResumed).toHaveBeenCalledOnce();
  });
  it("repauses locally and notifies daemon when confirmation fails", async () => {
    const f = await fixture();
    const work = f.bridge.handle(f.message, f.popup);
    f.setPaused(false);
    f.reply(false);
    expect(await work).toEqual({ ok: false, error: "busy" });
    expect(f.dispatcher.interruptSession).toHaveBeenCalledWith("one");
    expect(f.onPaused).toHaveBeenCalledWith("one");
    expect(f.sent).toContainEqual({
      event: "session.user_interrupt",
      payload: { session_id: "one" },
    });
    expect(f.onResumed).not.toHaveBeenCalled();
  });
  it("does not restore a session that stopped during the request", async () => {
    const f = await fixture();
    const work = f.bridge.handle(f.message, f.popup);
    await f.sessions.stop("one", { dropOnly: true });
    f.reply();
    expect(await work).toEqual({ ok: false, error: "stale" });
    expect(f.onResumed).not.toHaveBeenCalled();
  });
});
