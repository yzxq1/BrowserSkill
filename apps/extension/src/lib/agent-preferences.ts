import { defaultStorage, type StorageBackend } from "./instance-id";

export type WindowStrategy = "existing" | "dedicated";

export interface AgentPreferences {
  windowStrategy: WindowStrategy;
  autoCloseTabs: boolean;
}

export const AGENT_PREFERENCES_STORAGE_KEY = "bsk2_agent_preferences";
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  windowStrategy: "existing",
  autoCloseTabs: true,
};

export function normalizeAgentPreferences(value: unknown): AgentPreferences {
  const prefs = value as Partial<AgentPreferences> | null | undefined;
  return {
    windowStrategy: prefs?.windowStrategy === "dedicated" ? "dedicated" : "existing",
    autoCloseTabs: prefs?.autoCloseTabs !== false,
  };
}

export class AgentPreferenceStore {
  private value = { ...DEFAULT_AGENT_PREFERENCES };
  private readonly listeners = new Set<(value: AgentPreferences) => void>();
  private initialization?: Promise<void>;
  private listening = false;
  private loaded = false;

  constructor(private readonly storage: StorageBackend = defaultStorage()) {}

  get(): AgentPreferences {
    return { ...this.value };
  }

  subscribe(listener: (value: AgentPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(value: unknown): void {
    const next = normalizeAgentPreferences(value);
    this.loaded = true;
    if (
      next.windowStrategy === this.value.windowStrategy &&
      next.autoCloseTabs === this.value.autoCloseTabs
    ) {
      return;
    }
    this.value = next;
    for (const listener of this.listeners) listener(this.get());
  }

  async ready(): Promise<void> {
    if (this.loaded) return;
    if (this.initialization) return this.initialization;
    if (!this.listening) {
      chrome.storage?.onChanged?.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes[AGENT_PREFERENCES_STORAGE_KEY]) return;
        this.publish(changes[AGENT_PREFERENCES_STORAGE_KEY].newValue);
      });
      this.listening = true;
    }

    this.initialization = (async () => {
      try {
        const stored = await this.storage.get(AGENT_PREFERENCES_STORAGE_KEY);
        const raw = stored[AGENT_PREFERENCES_STORAGE_KEY];
        if (raw) {
          try {
            this.publish(typeof raw === "string" ? JSON.parse(raw) : raw);
          } catch {
            this.publish(raw);
          }
        } else {
          this.loaded = true;
        }
      } catch {
        this.loaded = true;
      }
    })();
    return this.initialization;
  }

  async set(next: AgentPreferences): Promise<void> {
    const normalized = normalizeAgentPreferences(next);
    this.value = normalized;
    await this.storage.set({ [AGENT_PREFERENCES_STORAGE_KEY]: normalized });
    for (const listener of this.listeners) listener(this.get());
  }
}

export const agentPreferences = new AgentPreferenceStore();
