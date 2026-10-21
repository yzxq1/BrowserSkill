import { useTranslation } from "@browser-skill/i18n/react";
import type { ResumeError } from "@/lib/session-control-client";

export interface PausedOverlayProps {
  visible: boolean;
  resuming: boolean;
  error: ResumeError | null;
  onResume(): void;
}

/** A small nonblocking pill: the user can keep using the paused page. */
export function PausedOverlay({ visible, resuming, error, onResume }: PausedOverlayProps) {
  const { t } = useTranslation("extension");
  if (!visible) return null;
  return (
    <section
      data-slot="paused-overlay"
      role="status"
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 2147483647,
        pointerEvents: "auto",
        maxWidth: 360,
        padding: 16,
        borderRadius: 16,
        background: "#fff",
        color: "#222",
        boxShadow: "0 4px 24px #0003",
        fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <strong>{t("resumeOverlay.paused")}</strong>
        <button
          data-slot="paused-overlay-resume"
          type="button"
          disabled={resuming}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) onResume();
          }}
          style={{
            cursor: resuming ? "wait" : "pointer",
            border: 0,
            borderRadius: 20,
            padding: "9px 16px",
            color: "white",
            background: resuming ? "#9ca3af" : "#2563eb",
          }}
        >
          {t(resuming ? "resumeOverlay.resuming" : "resumeOverlay.resume")}
        </button>
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 12, lineHeight: 1.5 }}>{t("resumeOverlay.hint")}</p>
      {error && (
        <p role="alert" style={{ margin: "8px 0 0", color: "#b91c1c", fontSize: 12 }}>
          {t(`resumeOverlay.error_${error}`)}
        </p>
      )}
    </section>
  );
}
