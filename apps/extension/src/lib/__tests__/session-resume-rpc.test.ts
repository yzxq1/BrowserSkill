import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStateHandler, FrameHandler, Transport } from "@/transport/transport";
import type { ProtocolFrame } from "@/transport/types";
import { requestSessionResume } from "../session-resume-rpc";

function fixture() {
  const messages = new Set<FrameHandler>(),
    states = new Set<ConnectionStateHandler>();
  const send = vi.fn();
  const transport = {
    state: "connected",
    send,
    onMessage: (fn: FrameHandler) => {
      messages.add(fn);
      return { dispose: () => messages.delete(fn) };
    },
    onConnectionStateChange: (fn: ConnectionStateHandler) => {
      states.add(fn);
      return { dispose: () => states.delete(fn) };
    },
  } as unknown as Transport;
  return {
    transport,
    send,
    messages,
    states,
    emit: (frame: ProtocolFrame) => {
      for (const fn of messages) fn(frame);
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("user-initiated session resume RPC", () => {
  it("requires a matching daemon success and disposes all listeners", async () => {
    const f = fixture();
    const request = requestSessionResume(f.transport, "one");
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.resume", params: { session_id: "one" } }),
    );
    f.emit({ id: "unrelated", result: { resumed: true } });
    expect(f.messages.size).toBe(1);
    f.emit({ id: f.send.mock.calls[0][0].id, result: { resumed: true } });
    await request;
    expect(f.messages.size).toBe(0);
    expect(f.states.size).toBe(0);
  });
  it.each([
    [{ code: "timeout", message: "busy", data: { reason: "session_busy" } }, "busy"],
    [{ code: "unknown_method", message: "old daemon" }, "unsupported"],
    [{ code: "not_found", message: "gone" }, "stale"],
    [{ code: "user_aborted", message: "new interrupt" }, "interrupted"],
  ])("keeps a rejected request explicit: %j", async (error, expected) => {
    const f = fixture();
    const request = requestSessionResume(f.transport, "one");
    f.emit({ id: f.send.mock.calls[0][0].id, error } as ProtocolFrame);
    await expect(request).rejects.toMatchObject({ reason: expected });
    expect(f.messages.size).toBe(0);
  });
  it("fails closed for malformed confirmation", async () => {
    const f = fixture();
    const request = requestSessionResume(f.transport, "one");
    f.emit({ id: f.send.mock.calls[0][0].id, result: { resumed: false } });
    await expect(request).rejects.toMatchObject({ reason: "failed" });
  });
  it("times out without leaking listeners or retrying", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = requestSessionResume(f.transport, "one", 10);
    const failed = expect(request).rejects.toMatchObject({ reason: "disconnected" });
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.messages.size).toBe(0);
    expect(f.states.size).toBe(0);
  });
  it("rejects disconnect and send failure", async () => {
    const f = fixture();
    const request = requestSessionResume(f.transport, "one");
    for (const fn of f.states) fn("disconnected");
    await expect(request).rejects.toMatchObject({ reason: "disconnected" });
    f.send.mockImplementation(() => {
      throw new Error("closed");
    });
    await expect(requestSessionResume(f.transport, "one")).rejects.toMatchObject({
      reason: "disconnected",
    });
    expect(f.messages.size).toBe(0);
  });
});
