import { invoke } from "@tauri-apps/api/core";
import type { ImportSummary, Reminder, ReminderInput, ReminderUpdate, TempoBackup } from "../shared/types";
import type { TempoSettings } from "../shared/types";
import { browserStore } from "./browserStore";

const browserSettingsKey = "tempo-assist-settings";

const defaultBrowserSettings: TempoSettings = {
  markdownDir: null,
  alarmSoundPath: null,
  reminderSoundPath: null,
  alarmVolume: 0.8,
  reminderVolume: 0.8,
};

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readBrowserSettings() {
  try {
    const stored = localStorage.getItem(browserSettingsKey);
    return stored ? ({ ...defaultBrowserSettings, ...JSON.parse(stored) } as TempoSettings) : defaultBrowserSettings;
  } catch {
    return defaultBrowserSettings;
  }
}

function writeBrowserSettings(patch: Partial<TempoSettings>) {
  const next = { ...readBrowserSettings(), ...patch };
  localStorage.setItem(browserSettingsKey, JSON.stringify(next));
  return next;
}

function downloadBrowserBackup(backup: TempoBackup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `tempo-assist-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function chooseBrowserBackupFile() {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function chooseBrowserSoundFile() {
  return new Promise<string | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/mpeg,audio/mp3,.mp3";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
  return invoke<T>(command, args);
}

export const reminderApi = {
  list: () => (isTauriRuntime() ? tauriInvoke<Reminder[]>("list_reminders") : browserStore.list()),
  create: (input: ReminderInput) =>
    isTauriRuntime() ? tauriInvoke<Reminder>("create_reminder", { input }) : browserStore.create(input),
  update: (id: string, patch: ReminderUpdate) =>
    isTauriRuntime() ? tauriInvoke<Reminder>("update_reminder", { id, patch }) : browserStore.update(id, patch),
  delete: (id: string) =>
    isTauriRuntime() ? tauriInvoke<void>("delete_reminder", { id }) : browserStore.delete(id),
  testAlarm: (title: string) =>
    isTauriRuntime() ? tauriInvoke<void>("test_alarm", { title }) : Promise.resolve(),
  settings: {
    get: () => (isTauriRuntime() ? tauriInvoke<TempoSettings>("get_settings") : Promise.resolve(readBrowserSettings())),
    path: () =>
      isTauriRuntime() ? tauriInvoke<string>("settings_path") : Promise.resolve("Browser preview storage"),
    update: (patch: Partial<TempoSettings>) =>
      isTauriRuntime()
        ? tauriInvoke<TempoSettings>("update_settings", { patch })
        : Promise.resolve(writeBrowserSettings(patch)),
    chooseMarkdownDir: () =>
      isTauriRuntime() ? tauriInvoke<string | null>("choose_markdown_dir") : Promise.resolve(null),
    chooseSoundFile: () =>
      isTauriRuntime() ? tauriInvoke<string | null>("choose_sound_file") : chooseBrowserSoundFile(),
  },
  notifications: {
    sync: (_reminders: Reminder[]) => Promise.resolve(),
  },
  backup: {
    export: async () => {
      if (isTauriRuntime()) {
        return tauriInvoke<string | null>("export_backup");
      }

      const backup: TempoBackup = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        reminders: await browserStore.list(),
        settings: readBrowserSettings(),
      };
      downloadBrowserBackup(backup);
      return "download";
    },
    import: async (): Promise<ImportSummary | null> => {
      if (isTauriRuntime()) {
        return tauriInvoke<ImportSummary | null>("import_backup");
      }

      const file = await chooseBrowserBackupFile();
      if (!file) {
        return null;
      }

      const backup = JSON.parse(await file.text()) as TempoBackup;
      if (backup.schemaVersion !== 1 || !Array.isArray(backup.reminders)) {
        throw new Error("Unsupported Tempo Assist backup file.");
      }
      return browserStore.import(backup.reminders);
    },
  },
  files: {
    audioDataUrl: (filePath: string) =>
      isTauriRuntime() ? tauriInvoke<string>("audio_data_url", { filePath }) : Promise.resolve(filePath),
  },
  windowControls: {
    minimize: () => (isTauriRuntime() ? tauriInvoke<void>("window_minimize") : Promise.resolve()),
    toggleMaximize: () => (isTauriRuntime() ? tauriInvoke<void>("window_toggle_maximize") : Promise.resolve()),
    close: () => (isTauriRuntime() ? tauriInvoke<void>("window_close") : Promise.resolve()),
  },
};
