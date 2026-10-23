import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type { ToolDispatcher } from "@/tools/dispatcher";
import type { Transport } from "@/transport/transport";
import {
  SESSION_CONTROL_MESSAGE,
  type SessionControlReply,
  type SessionControlRequest,
} from "./session-control-client";
import { ResumeFailure, requestSessionResume } from "./session-resume-rpc";

export interface SessionControlDeps {
  sessions: SessionManager;
  dispatcher: Pick<ToolDispatcher, "interruptSession" | "isSessionPaused">;
  transport: Transport;
  onPaused(sessionId: string): void;
  onResumed(sessionId: string): void;
}

export function isSessionControlPopup(sender: chrome.runtime.MessageSender): boolean {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  )
    return false;
  try {
    const url = new URL(sender.url),
      extension = new URL(chrome.runtime.getURL("/"));
    return (
      url.origin === extension.origin &&
      url.protocol === extension.protocol &&
      url.host === extension.host &&
      url.pathname === "/popup.html"
    );
  } catch {
    return false;
  }
}

/** Per-session identity and pending ownership outlive a popup closing. */
export class SessionControlBridge {
  private readonly pending = new Map<object, Promise<SessionControlReply>>();
  constructor(private readonly deps: SessionControlDeps) {}

  isResuming(sessionId: string): boolean {
    const ctx = this.deps.sessions.get(sessionId);
    return ctx !== null && this.pending.has(ctx);
  }

  async handle(raw: unknown, sender: chrome.runtime.MessageSender): Promise<SessionControlReply> {
    const request = raw as Partial<SessionControlRequest> | null;
    if (!request || request.kind !== SESSION_CONTROL_MESSAGE) return { ok: false, error: "failed" };
    const { sessions, dispatcher, transport } = this.deps;
    const popup = isSessionControlPopup(sender);
    if (request.action === "list") {
      if (!popup) return { ok: false, error: "failed" };
      return {
        ok: true,
        tasks: sessions
          .list()
          .filter((ctx) => dispatcher.isSessionPaused(ctx.sessionId) || this.pending.has(ctx))
          .map((ctx) => ({ sessionId: ctx.sessionId, resuming: this.pending.has(ctx) })),
      };
    }
    if (request.action !== "resume" || typeof request.sessionId !== "string" || !request.sessionId)
      return { ok: false, error: "failed" };
    const ctx = sessions.get(request.sessionId);
    if (!ctx) return { ok: false, error: "stale" };
    // A website/free tab/frame must never resume a different task. Popup pages
    // are privileged only after exact extension origin/path validation.
    if (
      !popup &&
      (sender.id !== chrome.runtime.id ||
        sender.frameId !== 0 ||
        sender.tab?.windowId !== ctx.agentWindowId ||
        typeof sender.tab.id !== "number" ||
        !isAgentControlledTab(ctx, sender.tab.id))
    )
      return { ok: false, error: "failed" };
    const existing = this.pending.get(ctx);
    if (existing) return existing;
    const resume = async (): Promise<SessionControlReply> => {
      try {
        await requestSessionResume(transport, ctx.sessionId);
        if (sessions.get(ctx.sessionId) !== ctx) return { ok: false, error: "stale" };
        if (dispatcher.isSessionPaused(ctx.sessionId)) return { ok: false, error: "interrupted" };
        this.deps.onResumed(ctx.sessionId);
        return { ok: true };
      } catch (error) {
        // A lost acknowledgement is not permission to assume success. Invalidate
        // any late local resume and keep both sides paused, without replaying input.
        if (sessions.get(ctx.sessionId) === ctx) {
          dispatcher.interruptSession(ctx.sessionId);
          this.deps.onPaused(ctx.sessionId);
          try {
            transport.send({
              event: "session.user_interrupt",
              payload: { session_id: ctx.sessionId },
            });
          } catch {
            /* disconnected: local pause remains */
          }
        }
        return { ok: false, error: error instanceof ResumeFailure ? error.reason : "failed" };
      }
    };
    const work = resume();
    this.pending.set(ctx, work);
    try {
      return await work;
    } finally {
      if (this.pending.get(ctx) === work) this.pending.delete(ctx);
    }
  }
}

export function attachSessionControlBridge(deps: SessionControlDeps): SessionControlBridge {
  const bridge = new SessionControlBridge(deps);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== SESSION_CONTROL_MESSAGE) return false;
    const reply = (value: SessionControlReply) => {
      try {
        respond(value);
      } catch {
        /* popup closed */
      }
    };
    void bridge.handle(message, sender).then(reply, () => reply({ ok: false, error: "failed" }));
    return true;
  });
  return bridge;
}
