import type { Transport } from "@/transport/transport";
import { isResponseFrame, type RpcError } from "@/transport/types";
import type { ResumeError } from "./session-control-client";

export class ResumeFailure extends Error {
  constructor(readonly reason: ResumeError) {
    super(reason);
  }
}
function reason(error: RpcError): ResumeError {
  if (!error || typeof error !== "object") return "failed";
  if (error.data?.reason === "session_busy") return "busy";
  if (
    error.code === "unsupported" ||
    error.code === "unknown_method" ||
    error.code === "version_too_old"
  )
    return "unsupported";
  if (error.code === "not_found") return "stale";
  if (error.code === "user_aborted") return "interrupted";
  if (error.code === "timeout") return "disconnected";
  return "failed";
}

/** Extension-initiated authenticated resume; only a daemon acknowledgement is success. */
export function requestSessionResume(
  transport: Transport,
  sessionId: string,
  timeoutMs = 35000,
): Promise<void> {
  if (transport.state !== "connected") return Promise.reject(new ResumeFailure("disconnected"));
  const id = `user-resume-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    let messages: { dispose(): void } | undefined;
    let states: { dispose(): void } | undefined;
    let settled = false;
    const timer = setTimeout(() => finish(new ResumeFailure("disconnected")), timeoutMs);
    function finish(error?: ResumeFailure) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      messages?.dispose();
      states?.dispose();
      if (error) reject(error);
      else resolve();
    }
    messages = transport.onMessage((message) => {
      if (!isResponseFrame(message) || message.id !== id) return;
      if ("error" in message) return finish(new ResumeFailure(reason(message.error)));
      const value = message.result as { resumed?: unknown } | null;
      finish(value?.resumed === true ? undefined : new ResumeFailure("failed"));
    });
    if (settled) messages.dispose();
    states = transport.onConnectionStateChange((state) => {
      if (state === "disconnected") finish(new ResumeFailure("disconnected"));
    });
    if (settled) states.dispose();
    if (settled) return;
    try {
      transport.send({ id, method: "session.resume", params: { session_id: sessionId } });
    } catch {
      finish(new ResumeFailure("disconnected"));
    }
  });
}
