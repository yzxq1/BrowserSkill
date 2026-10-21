import { afterEach, expect, it, vi } from "vitest";
import { SESSION_CONTROL_MESSAGE, sendSessionControl } from "../session-control-client";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("requires an explicit successful runtime reply", async () => {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const request = { kind: SESSION_CONTROL_MESSAGE, action: "resume", sessionId: "one" } as const;
  expect(await sendSessionControl(request)).toEqual({ ok: false, error: "failed" });
  sendMessage.mockResolvedValueOnce({ ok: false, error: "busy" });
  expect(await sendSessionControl(request)).toEqual({ ok: false, error: "busy" });
  sendMessage.mockResolvedValueOnce({ ok: true });
  expect((await sendSessionControl(request)).ok).toBe(true);
});
it("bounds an unavailable service worker without retrying", async () => {
  vi.useFakeTimers();
  const sendMessage = vi.fn(() => new Promise(() => {}));
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const pending = sendSessionControl(
    { kind: SESSION_CONTROL_MESSAGE, action: "resume", sessionId: "one" },
    10,
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toEqual({ ok: false, error: "disconnected" });
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
