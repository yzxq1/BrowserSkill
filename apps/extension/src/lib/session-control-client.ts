export const SESSION_CONTROL_MESSAGE = "bsk.session-control";

export type ResumeError =
  | "busy"
  | "disconnected"
  | "unsupported"
  | "interrupted"
  | "stale"
  | "failed";
export interface PausedTask {
  sessionId: string;
  resuming: boolean;
}
export type SessionControlRequest =
  | { kind: typeof SESSION_CONTROL_MESSAGE; action: "list" }
  | { kind: typeof SESSION_CONTROL_MESSAGE; action: "resume"; sessionId: string };
export type SessionControlReply =
  | { ok: true; tasks?: PausedTask[] }
  | { ok: false; error: ResumeError };

export async function sendSessionControl(
  request: SessionControlRequest,
  timeoutMs = request.action === "resume" ? 40000 : 2000,
): Promise<SessionControlReply> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    if (response?.ok === true) return { ok: true, tasks: response.tasks };
    const reasons: ResumeError[] = [
      "busy",
      "disconnected",
      "unsupported",
      "interrupted",
      "stale",
      "failed",
    ];
    return { ok: false, error: reasons.includes(response?.error) ? response.error : "failed" };
  } catch {
    return { ok: false, error: "disconnected" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
