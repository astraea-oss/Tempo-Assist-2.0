import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { addDays, addMinutes, addMonths, parseISO } from "date-fns";
import { invoke } from "@tauri-apps/api/core";
import type {
  ImportSummary,
  NotificationLeadTime,
  NotificationLeadUnit,
  Reminder,
  ReminderInput,
  ReminderUpdate,
  TempoBackup,
} from "../shared/types";
import type { TempoSettings } from "../shared/types";
import { browserStore } from "./browserStore";

const browserSettingsKey = "tempo-assist-settings";
const notificationChannelId = "tempo-assist-events";

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

const notificationUnitRank: Record<NotificationLeadUnit, number> = {
  months: 5,
  weeks: 4,
  days: 3,
  hours: 2,
  minutes: 1,
};

function isNotificationLeadUnit(unit: unknown): unit is NotificationLeadUnit {
  return typeof unit === "string" && unit in notificationUnitRank;
}

function normalizeNotificationLeadTimes(leadTimes?: NotificationLeadTime[] | null, offsets?: number[] | null) {
  const source: Array<{ value: unknown; unit: unknown }> =
    leadTimes && leadTimes.length > 0
      ? leadTimes
      : (offsets ?? [0]).map((offset) => ({ value: offset, unit: "minutes" as const }));
  const seen = new Set<string>();
  const normalized: NotificationLeadTime[] = [];

  for (const leadTime of source) {
    const value = Math.floor(Number(leadTime.value));
    const unit = leadTime.unit;
    if (!Number.isFinite(value) || value < 0 || !isNotificationLeadUnit(unit)) {
      continue;
    }

    const key = `${value}:${unit}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ value, unit });
    }
  }

  normalized.sort((a, b) => notificationUnitRank[b.unit] - notificationUnitRank[a.unit] || b.value - a.value);
  return normalized.length > 0 ? normalized : [{ value: 0, unit: "minutes" as const }];
}

function addOccurrence(date: Date, repeatRule: string) {
  if (repeatRule === "hourly") {
    return addMinutes(date, 60);
  }
  if (repeatRule === "daily") {
    return addDays(date, 1);
  }
  if (repeatRule === "weekly") {
    return addDays(date, 7);
  }
  if (repeatRule === "monthly") {
    return addMonths(date, 1);
  }
  if (repeatRule === "yearly") {
    const next = new Date(date);
    next.setFullYear(next.getFullYear() + 1);
    return next;
  }
  return date;
}

function nextOccurrence(reminder: Reminder, now: number) {
  let occurrence = parseISO(reminder.dueAt);
  if (!reminder.repeatRule || occurrence.getTime() > now) {
    return occurrence;
  }

  let guard = 0;
  while (occurrence.getTime() <= now && guard < 10_000) {
    occurrence = addOccurrence(occurrence, reminder.repeatRule);
    guard += 1;
  }

  return occurrence;
}

function alertDateForLeadTime(occurrence: Date, leadTime: NotificationLeadTime) {
  if (leadTime.value === 0) {
    return occurrence;
  }
  if (leadTime.unit === "months") {
    return addMonths(occurrence, -leadTime.value);
  }
  if (leadTime.unit === "weeks") {
    return addDays(occurrence, -leadTime.value * 7);
  }
  if (leadTime.unit === "days") {
    return addDays(occurrence, -leadTime.value);
  }
  if (leadTime.unit === "hours") {
    return addMinutes(occurrence, -leadTime.value * 60);
  }
  return addMinutes(occurrence, -leadTime.value);
}

function notificationLeadTimeLabel(leadTime: NotificationLeadTime) {
  if (leadTime.value === 0) {
    return "Due";
  }

  const unit = leadTime.value === 1 ? leadTime.unit.replace(/s$/, "") : leadTime.unit;
  return `${leadTime.value} ${unit} before`;
}

function notificationId(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) || 1;
}

async function ensureNotificationPermission() {
  if (!Capacitor.isPluginAvailable("LocalNotifications")) {
    return false;
  }

  const permissions = await LocalNotifications.checkPermissions();
  if (permissions.display === "granted") {
    return true;
  }

  const requested = await LocalNotifications.requestPermissions();
  return requested.display === "granted";
}

async function syncNativeNotifications(reminders: Reminder[]) {
  if (!Capacitor.isNativePlatform() || !(await ensureNotificationPermission())) {
    return;
  }

  await LocalNotifications.createChannel({
    id: notificationChannelId,
    name: "Tempo Assist events",
    description: "Reminders and alarms from Tempo Assist",
    importance: 4,
    visibility: 1,
    vibration: true,
  });

  const pending = await LocalNotifications.getPending();
  const tempoPending = pending.notifications.filter((notification) => notification.extra?.source === "tempo-assist");
  if (tempoPending.length > 0) {
    await LocalNotifications.cancel({ notifications: tempoPending.map(({ id }) => ({ id })) });
  }

  const now = Date.now();
  const notifications = reminders
    .filter((reminder) => reminder.status === "scheduled" || reminder.status === "snoozed")
    .flatMap((reminder) => {
      const occurrence = nextOccurrence(reminder, now);
      if (Number.isNaN(occurrence.getTime())) {
        return [];
      }

      return normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets)
        .map((leadTime) => ({ leadTime, at: alertDateForLeadTime(occurrence, leadTime) }))
        .filter(({ at }) => at.getTime() > now)
        .map(({ leadTime, at }) => {
          const key = `${reminder.id}:${occurrence.toISOString()}:${leadTime.value}:${leadTime.unit}`;
          const isDue = leadTime.value === 0;
          return {
            id: notificationId(key),
            title: reminder.title || (reminder.itemType === "alarm" ? "Alarm" : "Reminder"),
            body: isDue
              ? reminder.notes || `${reminder.itemType === "alarm" ? "Alarm" : "Reminder"} due now`
              : `${notificationLeadTimeLabel(leadTime)}: ${reminder.notes || "event upcoming"}`,
            schedule: { at, allowWhileIdle: true },
            channelId: notificationChannelId,
            autoCancel: true,
            extra: {
              source: "tempo-assist",
              reminderId: reminder.id,
              occurrenceIso: occurrence.toISOString(),
              leadTime,
            },
          };
        });
    });

  if (notifications.length > 0) {
    await LocalNotifications.schedule({ notifications });
  }
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
    sync: syncNativeNotifications,
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
