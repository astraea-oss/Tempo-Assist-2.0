import {
  addDays,
  addMinutes,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfYear,
  format,
  getDay,
  parseISO,
  startOfMonth,
  startOfYear,
} from "date-fns";
import {
  AlarmClock,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  Coffee,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  FolderOpen,
  Music,
  Pencil,
  Plus,
  Settings,
  TimerReset,
  X,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { reminderApi } from "./lib/reminderApi";
import type { NotificationLeadTime, NotificationLeadUnit, Reminder, ReminderItemType, TempoSettings } from "./shared/types";

const navItems: Array<[string, LucideIcon]> = [
  ["Timeline", Bell],
  ["Completed", CheckCircle2],
  ["Calendar", CalendarDays],
  ["Focus", TimerReset],
  ["Settings", Settings],
];

type ViewName = "timeline" | "completed" | "calendar" | "focus" | "settings";
type DuePopup = {
  item: Reminder;
  occurrenceIso: string;
  leadTime: NotificationLeadTime;
};

type TagFilterMode = "all" | "only" | "hide";
type CalendarMode = "daily" | "monthly" | "yearly";
type FocusMode = "work" | "shortBreak" | "longBreak";

const quickOffsets = [
  ["10m", 10],
  ["30m", 30],
  ["1h", 60],
] as const;

const notificationLeadTimePresets: Array<[string, NotificationLeadTime]> = [
  ["At time", { value: 0, unit: "minutes" }],
  ["5m", { value: 5, unit: "minutes" }],
  ["15m", { value: 15, unit: "minutes" }],
  ["30m", { value: 30, unit: "minutes" }],
  ["1h", { value: 1, unit: "hours" }],
  ["1d", { value: 1, unit: "days" }],
  ["1w", { value: 1, unit: "weeks" }],
  ["1mo", { value: 1, unit: "months" }],
] as const;

const notificationLeadUnits: Array<[NotificationLeadUnit, string]> = [
  ["minutes", "Minutes"],
  ["hours", "Hours"],
  ["days", "Days"],
  ["weeks", "Weeks"],
  ["months", "Months"],
];

const preAlertGraceMs = 60_000;

const recurrenceOptions = [
  ["none", "No repeat"],
  ["hourly", "Hourly"],
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["yearly", "Yearly"],
] as const;

const focusDurations: Record<FocusMode, number> = {
  work: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60,
};

const focusLabels: Record<FocusMode, string> = {
  work: "Focus",
  shortBreak: "Short break",
  longBreak: "Long break",
};

type RecurrenceValue = (typeof recurrenceOptions)[number][0];

function dateValue(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function timeValue(date: Date) {
  return format(date, "HH:mm");
}

function combineDateTime(date: string, time: string) {
  return new Date(`${date}T${time}`).toISOString();
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

function normalizeNotificationLeadTimes(
  leadTimes?: NotificationLeadTime[] | null,
  offsets?: number[] | null,
): NotificationLeadTime[] {
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

    const key = notificationLeadTimeKey({ value, unit });
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ value, unit });
    }
  }

  normalized.sort((a, b) => notificationUnitRank[b.unit] - notificationUnitRank[a.unit] || b.value - a.value);
  return normalized.length > 0 ? normalized : [{ value: 0, unit: "minutes" }];
}

function notificationLeadTimeKey(leadTime: NotificationLeadTime) {
  return `${leadTime.value}:${leadTime.unit}`;
}

function notificationLeadTimeLabel(leadTime: NotificationLeadTime) {
  if (leadTime.value === 0) {
    return "At time";
  }

  const unit = leadTime.value === 1 ? leadTime.unit.replace(/s$/, "") : leadTime.unit;
  return `${leadTime.value} ${unit} before`;
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

function notificationTimeLabel(date: string, time: string, leadTime: NotificationLeadTime) {
  const eventDate = new Date(`${date}T${time}`);
  if (Number.isNaN(eventDate.getTime())) {
    return notificationLeadTimeLabel(leadTime);
  }

  const alertDate = alertDateForLeadTime(eventDate, leadTime);
  return `${format(alertDate, "d MMM, HH:mm")}${leadTime.value === 0 ? " due" : ""}`;
}

function countdownLabel(dueAt: string, now: number) {
  const diff = Math.max(0, parseISO(dueAt).getTime() - now);
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);

  return [days, hours, minutes, seconds].map((value) => value.toString().padStart(2, "0")).join(":");
}

function focusTimeLabel(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function normalizePathInput(filePath: string | null) {
  if (!filePath) {
    return null;
  }

  let normalized = filePath.trim();
  while (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized || null;
}

function normalizeTags(input: string) {
  const seen = new Set<string>();
  return input
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
    .filter((tag) => {
      if (!tag || seen.has(tag)) {
        return false;
      }
      seen.add(tag);
      return true;
    });
}

function tagsValue(tags: string[]) {
  return tags.filter((tag) => tag !== "reminder" && tag !== "alarm").join(", ");
}

function withTypeTag(itemType: ReminderItemType, tags: string[]) {
  return [itemType, ...tags.filter((tag) => tag !== "reminder" && tag !== "alarm")];
}

function addOccurrence(date: Date, repeatRule: string) {
  const next = new Date(date);
  if (repeatRule === "hourly") {
    next.setHours(next.getHours() + 1);
  } else if (repeatRule === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (repeatRule === "weekly") {
    next.setDate(next.getDate() + 7);
  } else if (repeatRule === "monthly") {
    next.setMonth(next.getMonth() + 1);
  } else if (repeatRule === "yearly") {
    next.setFullYear(next.getFullYear() + 1);
  }
  return next;
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

function dueOccurrence(reminder: Reminder, now: number) {
  let occurrence = parseISO(reminder.dueAt);
  if (occurrence.getTime() > now) {
    return null;
  }

  if (!reminder.repeatRule) {
    return occurrence;
  }

  let guard = 0;
  while (guard < 10_000) {
    const next = addOccurrence(occurrence, reminder.repeatRule);
    if (next.getTime() > now) {
      return occurrence;
    }
    occurrence = next;
    guard += 1;
  }

  return occurrence;
}

function dueNotification(reminder: Reminder, now: number) {
  const leadTimes = normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets);
  const candidates: Array<{ occurrence: Date; leadTime: NotificationLeadTime; alertAt: Date }> = [];

  const atTime = leadTimes.find((leadTime) => leadTime.value === 0);
  if (atTime) {
    const occurrence = dueOccurrence(reminder, now);
    if (occurrence) {
      candidates.push({ occurrence, leadTime: atTime, alertAt: occurrence });
    }
  }

  const next = nextOccurrence(reminder, now);
  if (next.getTime() > now) {
    for (const leadTime of leadTimes.filter((item) => item.value > 0)) {
      const alertAt = alertDateForLeadTime(next, leadTime);
      const delay = now - alertAt.getTime();
      if (delay >= 0 && delay <= preAlertGraceMs) {
        candidates.push({ occurrence: next, leadTime, alertAt });
      }
    }
  }

  return candidates.sort((a, b) => a.alertAt.getTime() - b.alertAt.getTime())[0] ?? null;
}

export function App() {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [settings, setSettings] = useState<TempoSettings>({
    markdownDir: null,
    alarmSoundPath: null,
    reminderSoundPath: null,
    alarmVolume: 0.8,
    reminderVolume: 0.8,
  });
  const [settingsPath, setSettingsPath] = useState("");
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewName>("timeline");
  const [itemType, setItemType] = useState<ReminderItemType>("reminder");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");
  const [date, setDate] = useState(() => dateValue(new Date()));
  const [time, setTime] = useState(() => timeValue(addMinutes(new Date(), 30)));
  const [recurrence, setRecurrence] = useState<RecurrenceValue>("none");
  const [notificationLeadTimes, setNotificationLeadTimes] = useState<NotificationLeadTime[]>([
    { value: 0, unit: "minutes" },
  ]);
  const [customNotificationValue, setCustomNotificationValue] = useState("");
  const [customNotificationUnit, setCustomNotificationUnit] = useState<NotificationLeadUnit>("minutes");
  const [tagFilterMode, setTagFilterMode] = useState<TagFilterMode>("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [nextOnlyTags, setNextOnlyTags] = useState<string[]>([]);
  const [calendarMode, setCalendarMode] = useState<CalendarMode>("monthly");
  const [focusMode, setFocusMode] = useState<FocusMode>("work");
  const [focusSeconds, setFocusSeconds] = useState(focusDurations.work);
  const [focusRunning, setFocusRunning] = useState(false);
  const [completedFocusSessions, setCompletedFocusSessions] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [triggeredIds, setTriggeredIds] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [duePopup, setDuePopup] = useState<DuePopup | null>(null);
  const [compactMode, setCompactMode] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function refresh() {
    setReminders(await reminderApi.list());
  }

  useEffect(() => {
    refresh();
    reminderApi.settings.get().then(setSettings);
    reminderApi.settings.path().then(setSettingsPath);
  }, []);

  useEffect(() => {
    document.body.classList.remove("native-mobile");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!focusRunning) {
      return;
    }

    const timer = window.setInterval(() => {
      setFocusSeconds((current) => {
        if (current > 1) {
          return current - 1;
        }

        setFocusRunning(false);
        const nextCompletedSessions = completedFocusSessions + (focusMode === "work" ? 1 : 0);
        const nextMode = nextFocusMode(focusMode, nextCompletedSessions);
        if (focusMode === "work") {
          setCompletedFocusSessions(nextCompletedSessions);
        }
        setFocusMode(nextMode);
        return focusDurations[nextMode];
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [completedFocusSessions, focusMode, focusRunning]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (duePopup) {
        return;
      }

      const due = reminders
        .filter((item) => item.status === "scheduled" || item.status === "snoozed")
        .map((item) => ({ item, notification: dueNotification(item, now) }))
        .filter((entry): entry is { item: Reminder; notification: NonNullable<ReturnType<typeof dueNotification>> } =>
          Boolean(entry.notification),
        )
        .find(({ item, notification }) => {
          const key = `${item.id}:${notification.occurrence.toISOString()}:${notificationLeadTimeKey(notification.leadTime)}`;
          return !triggeredIds.includes(key);
        });

      if (due) {
        const key = `${due.item.id}:${due.notification.occurrence.toISOString()}:${notificationLeadTimeKey(due.notification.leadTime)}`;
        setTriggeredIds((ids) => [...ids, key]);
        playDueSound(due.item);
        setDuePopup({
          item: due.item,
          occurrenceIso: due.notification.occurrence.toISOString(),
          leadTime: due.notification.leadTime,
        });
      }
    }, 5000);

    return () => window.clearInterval(timer);
  }, [duePopup, reminders, settings, triggeredIds]);

  useEffect(() => {
    reminderApi.notifications.sync(reminders).catch((error) => {
      console.warn("Unable to sync native notifications.", error);
    });
  }, [reminders]);

  useEffect(() => {
    document.body.classList.toggle("compact-mode", compactMode);
    return () => document.body.classList.remove("compact-mode");
  }, [compactMode]);

  const stats = useMemo(() => {
    const active = reminders.filter((item) => item.status === "scheduled" || item.status === "snoozed");
    const upcoming = active
      .map((item) => ({ item, occurrence: nextOccurrence(item, now) }))
      .filter(({ occurrence }) => occurrence.getTime() > now)
      .sort((a, b) => a.occurrence.getTime() - b.occurrence.getTime())
      .slice(0, 3);
    return { upcoming };
  }, [reminders, now]);

  const upcomingItems = useMemo(() => {
    return reminders
      .filter((item) => item.status === "scheduled" || item.status === "snoozed")
      .map((item) => ({ item, occurrence: nextOccurrence(item, now) }))
      .filter(({ occurrence }) => occurrence.getTime() > now)
      .sort((a, b) => a.occurrence.getTime() - b.occurrence.getTime());
  }, [reminders, now]);

  const allTags = useMemo(() => {
    return Array.from(new Set(reminders.flatMap((item) => item.tags))).sort((a, b) => a.localeCompare(b));
  }, [reminders]);

  const activeItems = useMemo(() => {
    return collapseNextOnlyTags(
      filterByTags(reminders.filter((item) => item.status === "scheduled" || item.status === "snoozed"), tagFilterMode, selectedTags),
      nextOnlyTags,
      now,
    );
  }, [reminders, tagFilterMode, selectedTags, nextOnlyTags, now]);

  const completedItems = useMemo(
    () => filterByTags(reminders.filter((item) => item.status === "done"), tagFilterMode, selectedTags),
    [reminders, tagFilterMode, selectedTags],
  );

  const calendarItems = useMemo(
    () => filterByTags(reminders, tagFilterMode, selectedTags),
    [reminders, tagFilterMode, selectedTags],
  );

  function setQuickTime(offset: number | null) {
    const next = offset === null ? new Date(new Date().setHours(21, 0, 0, 0)) : addMinutes(new Date(), offset);
    setDate(dateValue(next));
    setTime(timeValue(next));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      return;
    }

    const payload = {
      itemType,
      title,
      notes,
      dueAt: combineDateTime(date, time),
      repeatRule: recurrence === "none" ? null : recurrence,
      notificationLeadTimes: normalizeNotificationLeadTimes(notificationLeadTimes),
      priority: "medium" as const,
      tags: withTypeTag(itemType, normalizeTags(tags)),
    };

    if (editingId) {
      await reminderApi.update(editingId, payload);
    } else {
      await reminderApi.create(payload);
    }

    resetForm();
    await refresh();
  }

  function resetForm() {
    setEditingId(null);
    setItemType("reminder");
    setTitle("");
    setNotes("");
    setTags("");
    setRecurrence("none");
    setNotificationLeadTimes([{ value: 0, unit: "minutes" }]);
    setCustomNotificationValue("");
    setCustomNotificationUnit("minutes");
    const next = addMinutes(new Date(), 30);
    setDate(dateValue(next));
    setTime(timeValue(next));
  }

  function edit(reminder: Reminder) {
    const due = parseISO(reminder.dueAt);
    setEditingId(reminder.id);
    setItemType(reminder.itemType);
    setTitle(reminder.title);
    setNotes(reminder.notes);
    setTags(tagsValue(reminder.tags));
    setDate(dateValue(due));
    setTime(timeValue(due));
    setRecurrence((reminder.repeatRule as RecurrenceValue | null) ?? "none");
    setNotificationLeadTimes(normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets));
    setCustomNotificationValue("");
    setCustomNotificationUnit("minutes");
  }

  async function saveSettings(patch: Partial<TempoSettings>) {
    setSettings(await reminderApi.settings.update(patch));
  }

  async function exportBackup() {
    try {
      const result = await reminderApi.backup.export();
      setBackupStatus(result ? `Exported backup to ${result}.` : "Export canceled.");
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : "Backup export failed.");
    }
  }

  async function importBackup() {
    try {
      const result = await reminderApi.backup.import();
      if (!result) {
        setBackupStatus("Import canceled.");
        return;
      }
      await refresh();
      setBackupStatus(
        `Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped}.`,
      );
    } catch (error) {
      setBackupStatus(error instanceof Error ? error.message : "Backup import failed.");
    }
  }

  async function chooseMarkdownDir() {
    const markdownDir = await reminderApi.settings.chooseMarkdownDir();
    if (markdownDir) {
      await saveSettings({ markdownDir });
      await refresh();
    }
  }

  async function chooseSound(setting: "alarmSoundPath" | "reminderSoundPath") {
    const filePath = await reminderApi.settings.chooseSoundFile();
    if (filePath) {
      await saveSettings({ [setting]: normalizePathInput(filePath) });
    }
  }

  async function playDueSound(reminder: Reminder) {
    const soundPath = reminder.itemType === "alarm" ? settings.alarmSoundPath : settings.reminderSoundPath;
    const volume = reminder.itemType === "alarm" ? settings.alarmVolume : settings.reminderVolume;
    await playSound(soundPath, volume);
  }

  async function playSound(soundPath: string | null, volume: number) {
    const normalizedPath = normalizePathInput(soundPath);
    if (!normalizedPath) {
      throw new Error("No audio file path set.");
    }

    const audioUrl = await reminderApi.files.audioDataUrl(normalizedPath);
    const audio = new Audio(audioUrl);
    audio.volume = Math.max(0, Math.min(1, volume));
    audioRef.current?.pause();
    audioRef.current = audio;
    await audio.play();
  }

  async function complete(reminder: Reminder) {
    await reminderApi.update(reminder.id, { status: "done" });
    await refresh();
  }

  async function completeOccurrence(reminder: Reminder, occurrenceIso: string) {
    if (!reminder.repeatRule) {
      await reminderApi.update(reminder.id, { status: "done" });
      await refresh();
      return;
    }

    const next = addOccurrence(parseISO(occurrenceIso), reminder.repeatRule);
    const completed = await reminderApi.create({
      itemType: reminder.itemType,
      title: reminder.title,
      notes: reminder.notes,
      dueAt: occurrenceIso,
      repeatRule: null,
      notificationLeadTimes: reminder.notificationLeadTimes,
      priority: reminder.priority,
      tags: reminder.tags,
    });

    await reminderApi.update(completed.id, { status: "done" });
    await reminderApi.update(reminder.id, { dueAt: next.toISOString(), status: "scheduled" });
    await refresh();
  }

  async function restore(reminder: Reminder) {
    await reminderApi.update(reminder.id, { status: "scheduled" });
    await refresh();
  }

  async function deleteCompleted(reminder: Reminder) {
    await reminderApi.delete(reminder.id);
    await refresh();
  }

  async function snooze(reminder: Reminder) {
    await reminderApi.update(reminder.id, {
      status: "snoozed",
      dueAt: addMinutes(new Date(), 10).toISOString(),
    });
    await refresh();
  }

  async function acknowledgeDue() {
    if (!duePopup) {
      return;
    }

    if (duePopup.leadTime.value > 0) {
      setDuePopup(null);
      return;
    }

    await completeOccurrence(duePopup.item, duePopup.occurrenceIso);
    setDuePopup(null);
  }

  async function snoozeDue() {
    if (!duePopup) {
      return;
    }

    if (duePopup.leadTime.value > 0) {
      setDuePopup(null);
      return;
    }

    await snooze(duePopup.item);
    setDuePopup(null);
  }

  function toggleSelectedTag(tag: string) {
    setSelectedTags((current) => toggleTag(current, tag));
  }

  function toggleNextOnlyTag(tag: string) {
    setNextOnlyTags((current) => toggleTag(current, tag));
  }

  function toggleNotificationLeadTime(leadTime: NotificationLeadTime) {
    setNotificationLeadTimes((current) => {
      const normalized = normalizeNotificationLeadTimes(current);
      const key = notificationLeadTimeKey(leadTime);
      const next = normalized.some((item) => notificationLeadTimeKey(item) === key)
        ? normalized.filter((item) => notificationLeadTimeKey(item) !== key)
        : [...normalized, leadTime];
      return normalizeNotificationLeadTimes(next);
    });
  }

  function addCustomNotificationLeadTime() {
    const value = Math.floor(Number(customNotificationValue));
    if (!Number.isFinite(value) || value < 0) {
      return;
    }

    setNotificationLeadTimes((current) =>
      normalizeNotificationLeadTimes([...current, { value, unit: customNotificationUnit }]),
    );
    setCustomNotificationValue("");
  }

  function chooseFocusMode(mode: FocusMode) {
    setFocusMode(mode);
    setFocusSeconds(focusDurations[mode]);
    setFocusRunning(false);
  }

  function resetFocusTimer() {
    setFocusSeconds(focusDurations[focusMode]);
    setFocusRunning(false);
  }

  function skipFocusTimer() {
    const nextMode = nextFocusMode(focusMode, completedFocusSessions + (focusMode === "work" ? 1 : 0));
    if (focusMode === "work") {
      setCompletedFocusSessions((sessions) => sessions + 1);
    }
    setFocusMode(nextMode);
    setFocusSeconds(focusDurations[nextMode]);
    setFocusRunning(false);
  }

  if (compactMode) {
    return (
      <main className="scrollbar-hidden h-screen overflow-hidden bg-[#080b10] p-2 text-slate-100">
        <CompactView now={now} onExit={() => setCompactMode(false)} upcoming={upcomingItems} />
        {duePopup ? <DueAlert onOk={acknowledgeDue} onSnooze={snoozeDue} popup={duePopup} /> : null}
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#080b10] text-slate-100">
      <div className="grid min-h-screen grid-cols-1 gap-2 p-2 lg:grid-cols-[220px_1fr] lg:p-2">
        <aside className="flex flex-col gap-3 rounded-lg border border-white/10 bg-[#0f141d] p-2 lg:justify-between lg:p-3">
          <div>
            <div className="flex cursor-move items-center gap-3 [-webkit-app-region:drag]" data-tauri-drag-region>
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-cyan-300 text-slate-950">
                <AlarmClock size={22} />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Tempo Assist</p>
                <h1 className="text-lg font-semibold">Time deck</h1>
              </div>
            </div>

            <nav className="mt-4 grid grid-cols-2 gap-1 [-webkit-app-region:no-drag] sm:grid-cols-3 lg:mt-6 lg:block lg:space-y-1">
              <button
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-300 transition hover:bg-white/7 hover:text-white"
                onClick={() => setCompactMode(true)}
                type="button"
              >
                <Minimize2 size={17} />
                <span>Compact</span>
              </button>
              {navItems.map(([label, Icon]) => (
                <button
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition hover:bg-white/7 hover:text-white ${
                    viewForLabel(label) === activeView
                      ? "bg-white/10 text-white"
                      : "text-slate-300"
                  }`}
                  key={label}
                  onClick={() => setActiveView(viewForLabel(label))}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="grid gap-2 [-webkit-app-region:no-drag] sm:grid-cols-3 lg:block lg:space-y-2">
            {stats.upcoming.length > 0 ? (
              stats.upcoming.map(({ item, occurrence }) => (
                <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-center" key={item.id}>
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="mt-0.5 font-mono text-lg font-semibold text-cyan-200">
                    {countdownLabel(occurrence.toISOString(), now)}
                  </p>
                </div>
              ))
            ) : (
              <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-center">
                <p className="truncate text-sm font-medium">Nothing scheduled</p>
              </div>
            )}
          </div>
        </aside>

        <section className="grid min-w-0 min-h-0">
          {activeView === "settings" ? (
            <SettingsPanel
              onChooseMarkdownDir={chooseMarkdownDir}
              onChooseSound={chooseSound}
              onExportBackup={exportBackup}
              onImportBackup={importBackup}
              onPreviewSound={playSound}
              onSaveSettings={saveSettings}
              backupStatus={backupStatus}
              settings={settings}
              settingsPath={settingsPath}
              tagFilter={
                <TagFilterPanel
                  mode={tagFilterMode}
                  nextOnlyTags={nextOnlyTags}
                  onModeChange={setTagFilterMode}
                  onToggleNextOnly={toggleNextOnlyTag}
                  onToggleSelected={toggleSelectedTag}
                  selectedTags={selectedTags}
                  tags={allTags}
                />
              }
            />
          ) : activeView === "completed" ? (
            <section className="rounded-lg border border-white/10 bg-[#0f141d] p-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Archive</p>
                <h2 className="text-2xl font-semibold">Completed</h2>
              </div>

              <ScheduleList
                emptyText="Completed reminders and alarms will appear here."
                items={completedItems}
                mode="completed"
                onDelete={deleteCompleted}
                onRestore={restore}
              />
            </section>
          ) : activeView === "calendar" ? (
            <CalendarPanel
              items={calendarItems}
              mode={calendarMode}
              onModeChange={setCalendarMode}
              onTagModeChange={setTagFilterMode}
              onToggleTag={toggleSelectedTag}
              selectedTags={selectedTags}
              tagMode={tagFilterMode}
              tags={allTags}
            />
          ) : activeView === "timeline" ? (
          <div className="grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_250px]">
            <div className="grid content-start gap-2">
              <section className="rounded-lg border border-white/10 bg-[#0f141d] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Schedule</p>
                    <h2 className="text-xl font-semibold sm:text-2xl">Reminders & alarms</h2>
                  </div>
                  <button
                    className="grid h-9 w-9 place-items-center rounded-md bg-white/10 text-cyan-200 hover:bg-white/15"
                    onClick={() => reminderApi.testAlarm("Tempo Assist")}
                    title="Test alarm"
                  >
                    <Bell size={17} />
                  </button>
                </div>

                <ScheduleList
                  emptyText="Add a reminder or alarm to begin."
                  items={activeItems}
                  mode="active"
                  now={now}
                  onComplete={complete}
                  onEdit={edit}
                  onSnooze={snooze}
                />
              </section>

            </div>

            <div className="grid min-w-0 content-start gap-2">
              <div className="rounded-lg border border-white/10 bg-[#111822] px-3 py-2 text-center">
                <p className="text-lg font-semibold text-slate-100">{format(new Date(now), "d MMMM yyyy")}</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-cyan-200 sm:text-3xl lg:text-2xl">{format(new Date(now), "HH:mm:ss")}</p>
              </div>

            <form className="min-w-0 rounded-lg border border-white/10 bg-[#111822] p-3" onSubmit={submit}>
              {editingId ? (
                <button className="mb-3 text-xs text-slate-400 hover:text-white" onClick={resetForm} type="button">
                  Cancel edit
                </button>
              ) : null}

              <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-950 p-1">
                {(["reminder", "alarm"] as ReminderItemType[]).map((option) => (
                  <button
                    className={`rounded px-3 py-2 text-sm capitalize ${
                      itemType === option ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:text-white"
                    }`}
                    key={option}
                    onClick={() => setItemType(option)}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>

              <label className="mt-4 block text-xs font-medium text-slate-300">
                Title
                <input
                  className="mt-1 w-full rounded-md border-white/10 bg-slate-950 text-sm text-white placeholder:text-slate-600"
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={itemType === "alarm" ? "Wake up" : "Take medication"}
                  value={title}
                />
              </label>

              <div className="mt-3 grid gap-2">
                <label className="block text-xs font-medium text-slate-300">
                  Date
                  <input
                    className="mt-1 w-full rounded-md border-white/10 bg-slate-950 text-sm text-white"
                    onChange={(event) => setDate(event.target.value)}
                    type="date"
                    value={date}
                  />
                </label>
                <label className="block text-xs font-medium text-slate-300">
                  Time
                  <input
                    className="mt-1 w-full rounded-md border-white/10 bg-slate-950 text-sm text-white"
                    onChange={(event) => setTime(event.target.value)}
                    type="time"
                    value={time}
                  />
                </label>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2">
                {quickOffsets.map(([label, offset]) => (
                  <button
                    className="rounded-md border border-white/10 px-2 py-2 text-xs text-slate-300 hover:bg-white/10 hover:text-white"
                    key={label}
                    onClick={() => setQuickTime(offset)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="mt-3 rounded-md border border-white/10 bg-white/[0.025] p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-slate-300">Notifications</p>
                  <p className="text-[11px] text-slate-500">
                    {normalizeNotificationLeadTimes(notificationLeadTimes).length} alert
                    {normalizeNotificationLeadTimes(notificationLeadTimes).length === 1 ? "" : "s"}
                  </p>
                </div>

                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  {notificationLeadTimePresets.map(([label, leadTime]) => {
                    const selected = normalizeNotificationLeadTimes(notificationLeadTimes).some(
                      (item) => notificationLeadTimeKey(item) === notificationLeadTimeKey(leadTime),
                    );
                    return (
                      <button
                        className={`rounded-md border px-2 py-1.5 text-xs ${
                          selected
                            ? "border-cyan-300/50 bg-cyan-300/15 text-cyan-100"
                            : "border-white/10 text-slate-400 hover:bg-white/10 hover:text-white"
                        }`}
                        key={label}
                        onClick={() => toggleNotificationLeadTime(leadTime)}
                        type="button"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-2 grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_auto] gap-2">
                  <input
                    className="min-w-0 rounded-md border-white/10 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-600"
                    min={0}
                    onChange={(event) => setCustomNotificationValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomNotificationLeadTime();
                      }
                    }}
                    placeholder="Amount"
                    type="number"
                    value={customNotificationValue}
                  />
                  <select
                    className="min-w-0 rounded-md border-white/10 bg-slate-950 px-2 py-2 text-xs text-white"
                    onChange={(event) => setCustomNotificationUnit(event.target.value as NotificationLeadUnit)}
                    value={customNotificationUnit}
                  >
                    {notificationLeadUnits.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded-md border border-cyan-300/30 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-300/10"
                    onClick={addCustomNotificationLeadTime}
                    type="button"
                  >
                    Add
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {normalizeNotificationLeadTimes(notificationLeadTimes).map((leadTime) => (
                    <button
                      className="inline-flex items-center gap-1 rounded border border-white/10 bg-slate-950 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10"
                      key={notificationLeadTimeKey(leadTime)}
                      onClick={() => toggleNotificationLeadTime(leadTime)}
                      title={`Remove ${notificationLeadTimeLabel(leadTime)}`}
                      type="button"
                    >
                      <span>{notificationTimeLabel(date, time, leadTime)}</span>
                      <X size={12} />
                    </button>
                  ))}
                </div>
              </div>

              <label className="mt-3 block text-xs font-medium text-slate-300">
                Tags
                <input
                  className="mt-1 w-full rounded-md border-white/10 bg-slate-950 text-sm text-white placeholder:text-slate-600"
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="birthday, family"
                  value={tags}
                />
              </label>

              <label className="mt-3 block text-xs font-medium text-slate-300">
                Recurrence
                <select
                  className="mt-1 w-full rounded-md border-white/10 bg-slate-950 text-sm text-white"
                  onChange={(event) => setRecurrence(event.target.value as RecurrenceValue)}
                  value={recurrence}
                >
                  {recurrenceOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mt-3 block text-xs font-medium text-slate-300">
                Notes
                <textarea
                  className="mt-1 h-20 w-full resize-none rounded-md border-white/10 bg-slate-950 text-sm text-white placeholder:text-slate-600"
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Optional context"
                  value={notes}
                />
              </label>

              <button className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950" type="submit">
                {editingId ? <Pencil size={16} /> : <Plus size={16} />}
                {editingId ? "Save changes" : itemType === "alarm" ? "Add alarm" : "Add reminder"}
              </button>
            </form>
            </div>
          </div>
          ) : activeView === "focus" ? (
            <FocusPanel
              completedSessions={completedFocusSessions}
              mode={focusMode}
              onModeChange={chooseFocusMode}
              onReset={resetFocusTimer}
              onSkip={skipFocusTimer}
              onToggleRunning={() => setFocusRunning((running) => !running)}
              running={focusRunning}
              seconds={focusSeconds}
            />
          ) : (
            <PlaceholderPanel title="Focus" />
          )}
        </section>
      </div>
      {duePopup ? <DueAlert onOk={acknowledgeDue} onSnooze={snoozeDue} popup={duePopup} /> : null}
    </main>
  );
}

function toggleTag(tags: string[], tag: string) {
  return tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag];
}

function filterByTags(items: Reminder[], mode: TagFilterMode, selectedTags: string[]) {
  if (mode === "all" || selectedTags.length === 0) {
    return items;
  }

  return items.filter((item) => {
    const hasSelectedTag = selectedTags.some((tag) => item.tags.includes(tag));
    return mode === "only" ? hasSelectedTag : !hasSelectedTag;
  });
}

function collapseNextOnlyTags(items: Reminder[], tags: string[], now: number) {
  if (tags.length === 0) {
    return items;
  }

  const hiddenIds = new Set<string>();
  for (const tag of tags) {
    const taggedItems = items
      .filter((item) => item.tags.includes(tag))
      .map((item) => ({ item, occurrence: nextOccurrence(item, now) }))
      .sort((a, b) => a.occurrence.getTime() - b.occurrence.getTime());

    taggedItems.slice(1).forEach(({ item }) => hiddenIds.add(item.id));
  }

  return items.filter((item) => !hiddenIds.has(item.id));
}

function dayKey(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function monthKey(date: Date) {
  return format(date, "yyyy-MM");
}

function intensityClass(count: number, max: number) {
  if (count === 0 || max === 0) {
    return "bg-slate-900";
  }

  const ratio = count / max;
  if (ratio >= 0.75) {
    return "bg-cyan-200";
  }
  if (ratio >= 0.5) {
    return "bg-cyan-400";
  }
  if (ratio >= 0.25) {
    return "bg-cyan-600";
  }
  return "bg-cyan-900";
}

function countByDay(items: Reminder[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = dayKey(parseISO(item.dueAt));
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function nextFocusMode(mode: FocusMode, completedSessions: number): FocusMode {
  if (mode !== "work") {
    return "work";
  }
  return completedSessions > 0 && completedSessions % 4 === 0 ? "longBreak" : "shortBreak";
}

function viewForLabel(label: string): ViewName {
  if (label === "Calendar") {
    return "calendar";
  }
  if (label === "Focus") {
    return "focus";
  }
  if (label === "Settings") {
    return "settings";
  }
  if (label === "Completed") {
    return "completed";
  }
  return "timeline";
}

function CompactView({
  now,
  onExit,
  upcoming,
}: {
  now: number;
  onExit: () => void;
  upcoming: Array<{ item: Reminder; occurrence: Date }>;
}) {
  return (
    <section className="flex h-full min-h-0 w-full min-w-0 flex-col gap-2 overflow-hidden">
      <div className="flex cursor-move items-center justify-between gap-2 rounded-md border border-white/10 bg-[#0f141d] px-2 py-1.5 [-webkit-app-region:drag]" data-tauri-drag-region>
        <div className="flex min-w-0 items-center gap-1.5" data-tauri-drag-region>
          <AlarmClock className="shrink-0 text-cyan-300" size={14} />
          <span className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-cyan-300">Upcoming</span>
        </div>
        <button
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-white/10 text-slate-300 hover:bg-white/10 [-webkit-app-region:no-drag]"
          onClick={onExit}
          title="Exit compact view"
          type="button"
        >
          <Maximize2 size={15} />
        </button>
      </div>

      <div className="scrollbar-hidden min-h-0 flex-1 space-y-2 overflow-y-auto">
        {upcoming.length > 0 ? (
          upcoming.map(({ item, occurrence }) => (
            <article
              className="grid min-h-[58px] min-w-0 grid-cols-[38px_minmax(0,1fr)] items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] p-2"
              key={`${item.id}:${occurrence.toISOString()}`}
            >
              <div className="flex h-10 w-[38px] items-center justify-center rounded border border-cyan-300/20 bg-cyan-300/10 text-center text-[10px] font-bold uppercase leading-none text-cyan-100">
                {compactTypeLabel(item.itemType)}
              </div>
              <div className="flex min-w-0 flex-col justify-center overflow-hidden">
                <p className="truncate text-[11px] font-semibold leading-4 text-slate-100">{item.title}</p>
                <p className="truncate font-mono text-[13px] font-semibold leading-4 text-cyan-200">
                  {countdownLabel(occurrence.toISOString(), now)}
                </p>
                <p className="truncate text-[10px] leading-4 text-slate-500">{format(occurrence, "EEE d MMM, HH:mm")}</p>
              </div>
            </article>
          ))
        ) : (
          <div className="rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-xs text-slate-400">
            Nothing scheduled
          </div>
        )}
      </div>
    </section>
  );
}

function compactTypeLabel(itemType: ReminderItemType) {
  return itemType === "alarm" ? "ALR" : "REM";
}

function FocusPanel({
  completedSessions,
  mode,
  onModeChange,
  onReset,
  onSkip,
  onToggleRunning,
  running,
  seconds,
}: {
  completedSessions: number;
  mode: FocusMode;
  onModeChange: (mode: FocusMode) => void;
  onReset: () => void;
  onSkip: () => void;
  onToggleRunning: () => void;
  running: boolean;
  seconds: number;
}) {
  const duration = focusDurations[mode];
  const progress = Math.max(0, Math.min(1, 1 - seconds / duration));
  const degrees = Math.round(progress * 360);

  return (
    <section className="grid min-h-0 min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="rounded-lg border border-white/10 bg-[#0f141d] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Focus</p>
            <h2 className="text-2xl font-semibold">Pomodoro timer</h2>
          </div>
          <div className="grid w-full grid-cols-3 gap-1 rounded-md bg-slate-950 p-1 sm:w-auto">
            {(["work", "shortBreak", "longBreak"] as FocusMode[]).map((option) => (
              <button
                className={`rounded px-2 py-2 text-xs sm:px-3 sm:text-sm ${
                  mode === option ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:text-white"
                }`}
                key={option}
                onClick={() => onModeChange(option)}
                type="button"
              >
                {focusLabels[option]}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8 grid place-items-center">
          <div
            className="grid h-64 w-64 place-items-center rounded-full border border-white/10 shadow-2xl sm:h-72 sm:w-72"
            style={{
              background: `conic-gradient(rgb(103 232 249) ${degrees}deg, rgba(15, 23, 42, 0.95) ${degrees}deg)`,
            }}
          >
            <div className="grid h-52 w-52 place-items-center rounded-full border border-white/10 bg-[#080b10] text-center sm:h-60 sm:w-60">
              <div>
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-md bg-cyan-300 text-slate-950">
                  {mode === "work" ? <TimerReset size={24} /> : <Coffee size={24} />}
                </div>
                <p className="mt-5 text-sm font-semibold uppercase tracking-[0.16em] text-cyan-300">{focusLabels[mode]}</p>
                <p className="mt-2 font-mono text-5xl font-semibold text-slate-100 sm:text-6xl">{focusTimeLabel(seconds)}</p>
                <p className="mt-2 text-sm text-slate-500">{Math.round(progress * 100)}% complete</p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-2">
          <button
            className="flex min-w-32 items-center justify-center gap-2 rounded-md bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950"
            onClick={onToggleRunning}
            type="button"
          >
            {running ? <Pause size={17} /> : <Play size={17} />}
            {running ? "Pause" : "Start"}
          </button>
          <button
            className="flex min-w-28 items-center justify-center gap-2 rounded-md border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/10"
            onClick={onReset}
            type="button"
          >
            <RotateCcw size={16} />
            Reset
          </button>
          <button
            className="flex min-w-28 items-center justify-center gap-2 rounded-md border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/10"
            onClick={onSkip}
            type="button"
          >
            <Check size={16} />
            Skip
          </button>
        </div>
      </div>

      <aside className="grid min-w-0 content-start gap-3">
        <div className="rounded-lg border border-white/10 bg-[#111822] p-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Cycle</p>
          <h3 className="mt-1 text-lg font-semibold">{completedSessions} focus session{completedSessions === 1 ? "" : "s"}</h3>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                className={`h-3 rounded-full ${
                  index < completedSessions % 4 ? "bg-cyan-300" : "bg-slate-800"
                }`}
                key={index}
              />
            ))}
          </div>
          <p className="mt-4 text-sm text-slate-500">A long break starts after every fourth focus session.</p>
        </div>

        <div className="rounded-lg border border-white/10 bg-[#111822] p-3">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Durations</p>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <div className="flex justify-between gap-3">
              <span>Focus</span>
              <span className="font-mono text-cyan-200">25:00</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Short break</span>
              <span className="font-mono text-cyan-200">05:00</span>
            </div>
            <div className="flex justify-between gap-3">
              <span>Long break</span>
              <span className="font-mono text-cyan-200">15:00</span>
            </div>
          </div>
        </div>
      </aside>
    </section>
  );
}

function PlaceholderPanel({ title }: { title: string }) {
  return (
    <section className="rounded-lg border border-white/10 bg-[#0f141d] p-3">
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">{title}</p>
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="mt-4 rounded-md border border-dashed border-white/15 p-6 text-sm text-slate-500">
        This view is ready for the next pass.
      </div>
    </section>
  );
}

function CalendarPanel({
  items,
  mode,
  onModeChange,
  onTagModeChange,
  onToggleTag,
  selectedTags,
  tagMode,
  tags,
}: {
  items: Reminder[];
  mode: CalendarMode;
  onModeChange: (mode: CalendarMode) => void;
  onTagModeChange: (mode: TagFilterMode) => void;
  onToggleTag: (tag: string) => void;
  selectedTags: string[];
  tagMode: TagFilterMode;
  tags: string[];
}) {
  const today = new Date();

  return (
    <section className="grid min-h-0 min-w-0 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="rounded-lg border border-white/10 bg-[#0f141d] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Calendar</p>
            <h2 className="text-2xl font-semibold">Event heatmap</h2>
          </div>
          <div className="grid w-full grid-cols-3 gap-1 rounded-md bg-slate-950 p-1 sm:w-auto">
            {(["daily", "monthly", "yearly"] as CalendarMode[]).map((option) => (
              <button
                className={`rounded px-2 py-2 text-xs capitalize sm:px-3 sm:text-sm ${
                  mode === option ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:text-white"
                }`}
                key={option}
                onClick={() => onModeChange(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          {mode === "daily" ? (
            <DailyHeatmap date={today} items={items} />
          ) : mode === "monthly" ? (
            <MonthlyHeatmap date={today} items={items} />
          ) : (
            <YearlyHeatmap date={today} items={items} />
          )}
        </div>
      </div>

      <CalendarTagPanel
        mode={tagMode}
        onModeChange={onTagModeChange}
        onToggleSelected={onToggleTag}
        selectedTags={selectedTags}
        tags={tags}
      />
    </section>
  );
}

function DailyHeatmap({ date, items }: { date: Date; items: Reminder[] }) {
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  const counts = items.reduce<Record<number, number>>((acc, item) => {
    const due = parseISO(item.dueAt);
    if (dayKey(due) === dayKey(date)) {
      const hour = due.getHours();
      acc[hour] = (acc[hour] ?? 0) + 1;
    }
    return acc;
  }, {});
  const max = Math.max(0, ...Object.values(counts));

  return (
    <div>
      <HeatmapHeader title={format(date, "EEEE d MMMM yyyy")} total={Object.values(counts).reduce((sum, count) => sum + count, 0)} />
      <div className="mt-4 grid grid-cols-6 gap-2">
        {hours.map((hour) => {
          const count = counts[hour] ?? 0;
          return (
            <div
              className={`grid aspect-[1.45] place-items-center rounded-md border border-white/10 ${intensityClass(count, max)}`}
              key={hour}
              title={`${hour.toString().padStart(2, "0")}:00 - ${count} event${count === 1 ? "" : "s"}`}
            >
              <span className={`text-xs font-semibold ${count > 0 && count / Math.max(max, 1) >= 0.75 ? "text-slate-950" : "text-slate-300"}`}>
                {hour.toString().padStart(2, "0")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MonthlyHeatmap({ date, items }: { date: Date; items: Reminder[] }) {
  const start = startOfMonth(date);
  const end = endOfMonth(date);
  const leading = getDay(start);
  const days = Array.from({ length: differenceInCalendarDays(end, start) + 1 }, (_, index) => addDays(start, index));
  const counts = countByDay(items.filter((item) => monthKey(parseISO(item.dueAt)) === monthKey(date)));
  const max = Math.max(0, ...Object.values(counts));

  return (
    <div>
      <HeatmapHeader title={format(date, "MMMM yyyy")} total={Object.values(counts).reduce((sum, count) => sum + count, 0)} />
      <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-slate-500 sm:gap-2 sm:text-[11px]">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-1 sm:gap-2">
        {Array.from({ length: leading }, (_, index) => (
          <div className="min-h-10 sm:aspect-square" key={`blank-${index}`} />
        ))}
        {days.map((day) => {
          const count = counts[dayKey(day)] ?? 0;
          return (
            <div
              className={`flex min-h-10 flex-col justify-between rounded-md border border-white/10 p-1.5 sm:aspect-square sm:p-2 ${intensityClass(count, max)}`}
              key={dayKey(day)}
              title={`${format(day, "EEE d MMM")} - ${count} event${count === 1 ? "" : "s"}`}
            >
              <span className={`text-[11px] font-semibold sm:text-xs ${count > 0 && count / Math.max(max, 1) >= 0.75 ? "text-slate-950" : "text-slate-300"}`}>
                {format(day, "d")}
              </span>
              {count > 0 ? <span className="text-right text-[11px] font-bold text-slate-950">{count}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function YearlyHeatmap({ date, items }: { date: Date; items: Reminder[] }) {
  const start = startOfYear(date);
  const end = endOfYear(date);
  const days = Array.from({ length: differenceInCalendarDays(end, start) + 1 }, (_, index) => addDays(start, index));
  const offsetDays = Array.from({ length: getDay(start) }, (_, index) => index);
  const counts = countByDay(items.filter((item) => parseISO(item.dueAt).getFullYear() === date.getFullYear()));
  const max = Math.max(0, ...Object.values(counts));

  return (
    <div>
      <HeatmapHeader title={format(date, "yyyy")} total={Object.values(counts).reduce((sum, count) => sum + count, 0)} />
      <div className="mt-4 overflow-x-auto pb-2">
        <div className="grid w-max grid-flow-col grid-rows-7 gap-1">
          {offsetDays.map((index) => (
            <div className="h-3 w-3 rounded-sm bg-transparent" key={`offset-${index}`} />
          ))}
          {days.map((day) => {
            const count = counts[dayKey(day)] ?? 0;
            return (
              <div
                className={`h-3 w-3 rounded-sm border border-white/5 ${intensityClass(count, max)}`}
                key={dayKey(day)}
                title={`${format(day, "EEE d MMM")} - ${count} event${count === 1 ? "" : "s"}`}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1 text-xs text-slate-500">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            className={`h-3 w-3 rounded-sm border border-white/5 ${
              ["bg-slate-900", "bg-cyan-900", "bg-cyan-600", "bg-cyan-400", "bg-cyan-200"][level]
            }`}
            key={level}
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

function HeatmapHeader({ title, total }: { title: string; total: number }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h3 className="text-xl font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-slate-500">{total} visible event{total === 1 ? "" : "s"}</p>
      </div>
    </div>
  );
}

function CalendarTagPanel({
  mode,
  onModeChange,
  onToggleSelected,
  selectedTags,
  tags,
}: {
  mode: TagFilterMode;
  onModeChange: (mode: TagFilterMode) => void;
  onToggleSelected: (tag: string) => void;
  selectedTags: string[];
  tags: string[];
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-[#111822] p-3">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Shown tags</p>
        <h2 className="text-lg font-semibold">Calendar filter</h2>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1 rounded-md bg-slate-950 p-1">
        {(["all", "only", "hide"] as TagFilterMode[]).map((option) => (
          <button
            className={`rounded px-2 py-1.5 text-xs capitalize ${
              mode === option ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:text-white"
            }`}
            key={option}
            onClick={() => onModeChange(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </div>

      {tags.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <button
              className={`rounded border px-2 py-1 text-xs ${
                selectedTags.includes(tag)
                  ? "border-cyan-300/50 bg-cyan-300/15 text-cyan-100"
                  : "border-white/10 text-slate-400 hover:bg-white/10 hover:text-white"
              }`}
              key={tag}
              onClick={() => onToggleSelected(tag)}
              type="button"
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">Add tags to events to filter the heatmap.</p>
      )}
    </section>
  );
}

function DueAlert({
  onOk,
  onSnooze,
  popup,
}: {
  onOk: () => Promise<void>;
  onSnooze: () => Promise<void>;
  popup: DuePopup;
}) {
  const isAlarm = popup.item.itemType === "alarm";
  const isPreAlert = popup.leadTime.value > 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-[#111822] p-5 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-md bg-cyan-300 text-slate-950">
            {isAlarm ? <AlarmClock size={22} /> : <Bell size={22} />}
          </div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.14em] text-cyan-300">
              {isPreAlert ? notificationLeadTimeLabel(popup.leadTime) : isAlarm ? "Alarm" : "Reminder"}
            </p>
            <h2 className="truncate text-xl font-semibold">{popup.item.title}</h2>
          </div>
        </div>
        {popup.item.notes ? <p className="mt-4 text-sm text-slate-300">{popup.item.notes}</p> : null}
        <p className="mt-3 text-xs text-slate-500">
          Event time: {format(parseISO(popup.occurrenceIso), "EEE d MMM, HH:mm")}
        </p>

        <div className={`mt-5 grid gap-2 ${isAlarm && !isPreAlert ? "grid-cols-2" : "grid-cols-1"}`}>
          {isAlarm && !isPreAlert ? (
            <button className="rounded-md bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950" onClick={onSnooze} type="button">
              Snooze
            </button>
          ) : null}
          <button className="rounded-md bg-cyan-300 px-4 py-2.5 text-sm font-semibold text-slate-950" onClick={onOk} type="button">
            {isPreAlert ? "Dismiss" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TagFilterPanel({
  compact = false,
  mode,
  nextOnlyTags,
  onModeChange,
  onToggleNextOnly,
  onToggleSelected,
  selectedTags,
  tags,
}: {
  compact?: boolean;
  mode: TagFilterMode;
  nextOnlyTags: string[];
  onModeChange: (mode: TagFilterMode) => void;
  onToggleNextOnly: (tag: string) => void;
  onToggleSelected: (tag: string) => void;
  selectedTags: string[];
  tags: string[];
}) {
  return (
    <section className={`rounded-lg border border-white/10 bg-[#111822] p-3`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Tags</p>
          <h2 className={compact ? "text-sm font-semibold" : "text-lg font-semibold"}>Filters</h2>
        </div>
        <button
          className="rounded-md border border-white/10 px-2 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          onClick={() => {
            onModeChange("all");
            selectedTags.forEach(onToggleSelected);
            nextOnlyTags.forEach(onToggleNextOnly);
          }}
          type="button"
        >
          Clear
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-1 rounded-md bg-slate-950 p-1">
        {(["all", "only", "hide"] as TagFilterMode[]).map((option) => (
          <button
            className={`rounded px-1.5 py-1.5 text-xs capitalize ${
              mode === option ? "bg-cyan-300 text-slate-950" : "text-slate-400 hover:text-white"
            }`}
            key={option}
            onClick={() => onModeChange(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </div>

      {tags.length > 0 ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <button
                className={`rounded border px-2 py-1 text-xs ${
                  selectedTags.includes(tag)
                    ? "border-cyan-300/50 bg-cyan-300/15 text-cyan-100"
                    : "border-white/10 text-slate-400 hover:bg-white/10 hover:text-white"
                }`}
                key={tag}
                onClick={() => onToggleSelected(tag)}
                type="button"
              >
                #{tag}
              </button>
            ))}
          </div>

          <div>
            <p className="text-xs font-medium text-slate-400">Show next only</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <button
                  className={`rounded border px-2 py-1 text-xs ${
                    nextOnlyTags.includes(tag)
                      ? "border-amber-300/50 bg-amber-300/15 text-amber-100"
                      : "border-white/10 text-slate-400 hover:bg-white/10 hover:text-white"
                  }`}
                  key={tag}
                  onClick={() => onToggleNextOnly(tag)}
                  type="button"
                >
                  #{tag}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">Tags appear here after you add them to events.</p>
      )}
    </section>
  );
}

function ScheduleList({
  emptyText,
  items,
  mode,
  now,
  onComplete,
  onDelete,
  onEdit,
  onRestore,
  onSnooze,
}: {
  emptyText: string;
  items: Reminder[];
  mode: "active" | "completed";
  now?: number;
  onComplete?: (reminder: Reminder) => Promise<void>;
  onDelete?: (reminder: Reminder) => Promise<void>;
  onEdit?: (reminder: Reminder) => void;
  onRestore?: (reminder: Reminder) => Promise<void>;
  onSnooze?: (reminder: Reminder) => Promise<void>;
}) {
  return (
    <div className="mt-4 space-y-2">
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-white/15 p-6 text-center text-sm text-slate-500">{emptyText}</div>
      ) : (
        items.map((reminder) => {
          const displayDueAt = now && mode === "active" ? nextOccurrence(reminder, now).toISOString() : reminder.dueAt;
          const alertCount = normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets).length;
          return (
          <article
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 rounded-md border border-white/10 bg-white/[0.035] px-3 py-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
            key={reminder.id}
          >
            <div className="grid h-10 w-10 place-items-center rounded-md bg-slate-950 text-cyan-200">
              {reminder.itemType === "alarm" ? <AlarmClock size={18} /> : <Bell size={18} />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">
                  {reminder.itemType}
                </span>
                {reminder.repeatRule ? (
                  <span className="rounded border border-cyan-300/20 bg-cyan-300/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-100">
                    {reminder.repeatRule}
                  </span>
                ) : null}
                {reminder.tags
                  .filter((tag) => tag !== reminder.itemType)
                  .map((tag) => (
                    <span
                      className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold text-slate-300"
                      key={tag}
                    >
                      #{tag}
                    </span>
                  ))}
                <span className="text-xs text-slate-500">{format(parseISO(displayDueAt), "EEE d MMM, HH:mm")}</span>
                <span className="rounded border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold text-slate-300">
                  {alertCount} alert{alertCount === 1 ? "" : "s"}
                </span>
              </div>
              <h3 className="mt-1 truncate text-base font-semibold">{reminder.title}</h3>
              {reminder.notes ? <p className="truncate text-xs text-slate-400">{reminder.notes}</p> : null}
            </div>
            {mode === "active" ? (
              <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
                <button
                  className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-slate-300 hover:bg-white/10"
                  onClick={() => onSnooze?.(reminder)}
                  title="Snooze 10 minutes"
                >
                  <Clock3 size={16} />
                </button>
                <button
                  className="grid h-8 w-8 place-items-center rounded-md border border-white/10 text-slate-300 hover:bg-white/10"
                  onClick={() => onEdit?.(reminder)}
                  title="Edit"
                >
                  <Pencil size={15} />
                </button>
                <button
                  className="grid h-8 w-8 place-items-center rounded-md bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/20"
                  onClick={() => onComplete?.(reminder)}
                  title="Complete"
                >
                  <Check size={16} />
                </button>
              </div>
            ) : (
              <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
                <button
                  className="grid h-8 w-8 place-items-center rounded-md bg-amber-300/15 text-amber-100 hover:bg-amber-300/25"
                  onClick={() => onRestore?.(reminder)}
                  title="Undo complete"
                >
                  <RotateCcw size={15} />
                </button>
                <button
                  className="grid h-8 w-8 place-items-center rounded-md bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
                  onClick={() => onDelete?.(reminder)}
                  title="Delete this completed instance"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </article>
          );
        })
      )}
    </div>
  );
}

function SettingsPanel({
  backupStatus,
  onChooseMarkdownDir,
  onChooseSound,
  onExportBackup,
  onImportBackup,
  onPreviewSound,
  onSaveSettings,
  settings,
  settingsPath,
  tagFilter,
}: {
  backupStatus: string | null;
  onChooseMarkdownDir: () => Promise<void>;
  onChooseSound: (setting: "alarmSoundPath" | "reminderSoundPath") => Promise<void>;
  onExportBackup: () => Promise<void>;
  onImportBackup: () => Promise<void>;
  onPreviewSound: (soundPath: string | null, volume: number) => Promise<void>;
  onSaveSettings: (patch: Partial<TempoSettings>) => Promise<void>;
  settings: TempoSettings;
  settingsPath: string;
  tagFilter: ReactNode;
}) {
  const [draft, setDraft] = useState(settings);
  const [previewStatus, setPreviewStatus] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  async function saveDraft() {
    await onSaveSettings({
      ...draft,
      alarmSoundPath: normalizePathInput(draft.alarmSoundPath),
      reminderSoundPath: normalizePathInput(draft.reminderSoundPath),
      markdownDir: normalizePathInput(draft.markdownDir),
    });
  }

  async function preview(soundPath: string | null, volume: number, label: string) {
    try {
      setPreviewStatus(`Playing ${label}...`);
      await onPreviewSound(normalizePathInput(soundPath), volume);
      setPreviewStatus(`${label} preview started.`);
    } catch (error) {
      setPreviewStatus(error instanceof Error ? error.message : "Preview failed.");
    }
  }

  return (
    <section className="grid content-start gap-4">
      <div className="rounded-lg border border-white/10 bg-[#0f141d] p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Settings</p>
            <h2 className="text-2xl font-semibold">Files & sounds</h2>
            <p className="mt-2 truncate text-xs text-slate-500">{settingsPath}</p>
            {previewStatus ? <p className="mt-2 text-xs text-amber-200">{previewStatus}</p> : null}
          </div>
          <button className="rounded-md bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950" onClick={saveDraft} type="button">
            Save
          </button>
        </div>

        <div className="mt-5 grid max-w-4xl gap-3">
          <SettingRow
            icon={<Music size={18} />}
            label="Alarm MP3"
            onPreview={() => preview(draft.alarmSoundPath, draft.alarmVolume, "alarm")}
            onBrowse={() => onChooseSound("alarmSoundPath")}
            onClear={() => setDraft((current) => ({ ...current, alarmSoundPath: null }))}
            onValueChange={(value) => setDraft((current) => ({ ...current, alarmSoundPath: normalizePathInput(value) }))}
            value={draft.alarmSoundPath}
          />
          <VolumeRow
            label="Alarm volume"
            onValueChange={(value) => setDraft((current) => ({ ...current, alarmVolume: value }))}
            value={draft.alarmVolume}
          />
          <SettingRow
            icon={<Music size={18} />}
            label="Reminder MP3"
            onPreview={() => preview(draft.reminderSoundPath, draft.reminderVolume, "reminder")}
            onBrowse={() => onChooseSound("reminderSoundPath")}
            onClear={() => setDraft((current) => ({ ...current, reminderSoundPath: null }))}
            onValueChange={(value) => setDraft((current) => ({ ...current, reminderSoundPath: normalizePathInput(value) }))}
            value={draft.reminderSoundPath}
          />
          <VolumeRow
            label="Reminder volume"
            onValueChange={(value) => setDraft((current) => ({ ...current, reminderVolume: value }))}
            value={draft.reminderVolume}
          />
          <SettingRow
            icon={<FolderOpen size={18} />}
            label="Markdown folder"
            onBrowse={onChooseMarkdownDir}
            onClear={() => setDraft((current) => ({ ...current, markdownDir: null }))}
            onValueChange={(value) => setDraft((current) => ({ ...current, markdownDir: normalizePathInput(value) }))}
            value={draft.markdownDir}
          />
        </div>
      </div>
      <div className="max-w-4xl rounded-lg border border-white/10 bg-[#0f141d] p-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-cyan-300">Backup</p>
            <h2 className="text-xl font-semibold">Move events between devices</h2>
            {backupStatus ? <p className="mt-2 text-sm text-amber-200">{backupStatus}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950"
              onClick={onExportBackup}
              type="button"
            >
              Export
            </button>
            <button
              className="rounded-md border border-cyan-300/30 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-300/10"
              onClick={onImportBackup}
              type="button"
            >
              Import
            </button>
          </div>
        </div>
      </div>
      <div className="max-w-4xl">{tagFilter}</div>
    </section>
  );
}

function SettingRow({
  icon,
  label,
  onBrowse,
  onClear,
  onPreview,
  onValueChange,
  value,
}: {
  icon: ReactNode;
  label: string;
  onBrowse: () => Promise<void>;
  onClear: () => void;
  onPreview?: () => Promise<void>;
  onValueChange: (value: string) => void;
  value: string | null;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-md border border-white/10 bg-white/[0.035] p-3 lg:grid-cols-[auto_150px_1fr_auto_auto_auto]">
      <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-cyan-200">{icon}</div>
      <span className="text-sm font-medium text-slate-200">{label}</span>
      <input
        className="col-span-2 min-w-0 rounded-md border-white/10 bg-slate-950 px-3 py-2 text-xs text-slate-300 placeholder:text-slate-600 lg:col-span-1"
        onBlur={(event) => onValueChange(event.target.value.trim())}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        placeholder="Default"
        value={value ?? ""}
      />
      <button className="rounded-md bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950" onClick={onBrowse} type="button">
        Browse
      </button>
      <button
        className="rounded-md border border-cyan-300/30 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!value || !onPreview}
        onClick={onPreview}
        type="button"
      >
        Preview
      </button>
      <button className="rounded-md border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/10" onClick={onClear} type="button">
        Clear
      </button>
    </div>
  );
}

function VolumeRow({
  label,
  onValueChange,
  value,
}: {
  label: string;
  onValueChange: (value: number) => void;
  value: number;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr_54px] items-center gap-3 rounded-md border border-white/10 bg-white/[0.025] p-3 lg:grid-cols-[auto_150px_1fr_54px]">
      <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-cyan-200">
        <Music size={18} />
      </div>
      <span className="text-sm font-medium text-slate-200 lg:whitespace-nowrap">{label}</span>
      <input
        className="col-span-2 accent-cyan-300 lg:col-span-1"
        max={100}
        min={0}
        onChange={(event) => onValueChange(Number(event.target.value) / 100)}
        type="range"
        value={Math.round(value * 100)}
      />
      <span className="text-right font-mono text-xs text-slate-400">{Math.round(value * 100)}%</span>
    </div>
  );
}







