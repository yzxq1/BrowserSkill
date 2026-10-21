import { useTranslation } from "@browser-skill/i18n/react";
import { useEffect, useState } from "react";
import {
  type PausedTask,
  type ResumeError,
  SESSION_CONTROL_MESSAGE,
  sendSessionControl,
} from "@/lib/session-control-client";

export function ResumeTasks({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("extension");
  const [tasks, setTasks] = useState<PausedTask[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<ResumeError | null>(null);
  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      return;
    }
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const reply = await sendSessionControl({ kind: SESSION_CONTROL_MESSAGE, action: "list" });
        if (active && reply.ok) setTasks(Array.isArray(reply.tasks) ? reply.tasks : []);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [enabled]);
  if (!enabled || tasks.length === 0) return null;
  const resume = async (sessionId: string) => {
    if (pending) return;
    setPending(sessionId);
    setError(null);
    try {
      const reply = await sendSessionControl({
        kind: SESSION_CONTROL_MESSAGE,
        action: "resume",
        sessionId,
      });
      if (reply.ok) setTasks((current) => current.filter((task) => task.sessionId !== sessionId));
      else setError(reply.error);
    } finally {
      setPending(null);
    }
  };
  return (
    <section
      data-slot="popup-paused-tasks"
      className="space-y-2 rounded-xl border border-blue-300 bg-card px-3 py-2.5"
    >
      <h2 className="text-sm font-medium">{t("resumeOverlay.tasks")}</h2>
      {tasks.map((task) => (
        <div key={task.sessionId} className="flex items-center justify-between gap-2 text-xs">
          <span>{t("resumeOverlay.task", { sessionId: task.sessionId })}</span>
          <button
            type="button"
            data-slot="popup-resume-task"
            disabled={pending !== null || task.resuming}
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) void resume(task.sessionId);
            }}
            className="rounded-lg bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
          >
            {t(
              pending === task.sessionId || task.resuming
                ? "resumeOverlay.resuming"
                : "resumeOverlay.resume",
            )}
          </button>
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">{t("resumeOverlay.hint")}</p>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {t(`resumeOverlay.error_${error}`)}
        </p>
      )}
    </section>
  );
}
