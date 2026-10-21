import { useEffect, useState } from "react";
import { agentPreferences, type WindowStrategy } from "@/lib/agent-preferences";
import { Switch } from "./switch";

export function AgentStrategySettings() {
  const [prefs, setPrefs] = useState(agentPreferences.get());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = agentPreferences.subscribe(setPrefs);
    void agentPreferences.ready().then(() => {
      if (active) setLoaded(true);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const setStrategy = (strategy: WindowStrategy) => {
    void agentPreferences.set({ ...prefs, windowStrategy: strategy });
  };

  const setAutoClose = (autoClose: boolean) => {
    void agentPreferences.set({ ...prefs, autoCloseTabs: autoClose });
  };

  return (
    <>
      {/* 圈一：窗口模式选项（当前窗口追加 vs 独立窗口） */}
      <section
        className="space-y-2.5 rounded-xl border border-blue-500/30 bg-card/60 p-2.5"
        data-slot="popup-window-strategy-card"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground/90">Agent 窗口模式</span>
          <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-400">
            bsk2 专属
          </span>
        </div>

        <div className="space-y-1.5">
          {/* 追加模式 */}
          <button
            type="button"
            disabled={!loaded}
            onClick={() => setStrategy("existing")}
            className={`flex w-full items-start gap-2 rounded-lg border p-2 text-left transition-all ${
              prefs.windowStrategy === "existing"
                ? "border-blue-500/80 bg-blue-500/10 text-foreground"
                : "border-border/40 bg-background/40 text-foreground/75 hover:border-border/70"
            }`}
          >
            <div className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-blue-500">
              {prefs.windowStrategy === "existing" && (
                <div className="size-2 rounded-full bg-blue-500" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-tight">当前窗口追加模式 (推荐)</div>
              <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                在当前窗口末尾静默加 Tab，不弹新窗口、不抢焦点
              </div>
            </div>
          </button>

          {/* 独立窗口模式 */}
          <button
            type="button"
            disabled={!loaded}
            onClick={() => setStrategy("dedicated")}
            className={`flex w-full items-start gap-2 rounded-lg border p-2 text-left transition-all ${
              prefs.windowStrategy === "dedicated"
                ? "border-blue-500/80 bg-blue-500/10 text-foreground"
                : "border-border/40 bg-background/40 text-foreground/75 hover:border-border/70"
            }`}
          >
            <div className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/60">
              {prefs.windowStrategy === "dedicated" && (
                <div className="size-2 rounded-full bg-blue-500" />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium leading-tight">独立 Agent 窗口模式</div>
              <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                新建独立窗口；后续所有任务均集中在该窗口运行
              </div>
            </div>
          </button>
        </div>
      </section>

      {/* 圈二：任务结束自动清理 */}
      <section
        className="rounded-xl border border-border/80 bg-card/60 p-2.5"
        data-slot="popup-cleanup-strategy-card"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="block text-[12px] font-medium text-foreground/90">
              任务完成时自动关闭页面
            </span>
            <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
              Agent 停止或完成后，自动清理自身创建的标签页
            </span>
          </div>
          <Switch
            checked={prefs.autoCloseTabs}
            disabled={!loaded}
            onCheckedChange={setAutoClose}
            aria-label="任务完成时自动关闭页面"
          />
        </div>
      </section>
    </>
  );
}
