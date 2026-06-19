import type { ImportSummary, NotificationLeadTime, NotificationLeadUnit, Reminder, ReminderInput, ReminderUpdate } from "../shared/types";

const storageKey = "tempo-forge-reminders";

function read(): Reminder[] {
  return JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Reminder[];
}

function write(reminders: Reminder[]) {
  localStorage.setItem(storageKey, JSON.stringify(reminders));
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

function normalizeNotificationLeadTimes(leadTimes?: NotificationLeadTime[], offsets?: number[]): NotificationLeadTime[] {
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
  return normalized.length > 0 ? normalized : [{ value: 0, unit: "minutes" }];
}

export const browserStore = {
  async list() {
    return read()
      .map((reminder) => ({
        ...reminder,
        notificationLeadTimes: normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets),
      }))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  },
  async create(input: ReminderInput) {
    const now = new Date().toISOString();
    const reminder: Reminder = {
      id: crypto.randomUUID(),
      itemType: input.itemType,
      title: input.title,
      notes: input.notes ?? "",
      dueAt: input.dueAt,
      repeatRule: input.repeatRule ?? null,
      notificationLeadTimes: normalizeNotificationLeadTimes(input.notificationLeadTimes, input.notificationOffsets),
      priority: input.priority,
      status: "scheduled",
      tags: input.tags ?? [],
      markdownPath: "",
      createdAt: now,
      updatedAt: now,
    };

    write([...read(), reminder]);
    return reminder;
  },
  async update(id: string, patch: ReminderUpdate) {
    const reminders = read();
    const reminder = reminders.find((item) => item.id === id);
    if (!reminder) {
      throw new Error(`Reminder not found: ${id}`);
    }

    Object.assign(reminder, patch, {
      notificationLeadTimes: normalizeNotificationLeadTimes(
        patch.notificationLeadTimes ?? reminder.notificationLeadTimes,
        patch.notificationOffsets ?? reminder.notificationOffsets,
      ),
      updatedAt: new Date().toISOString(),
    });
    write(reminders);
    return reminder;
  },
  async delete(id: string) {
    write(read().filter((item) => item.id !== id));
  },
  async import(reminders: Reminder[]): Promise<ImportSummary> {
    const current = read();
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (const reminder of reminders) {
      if (!reminder.id || !reminder.title || !reminder.dueAt) {
        skipped += 1;
        continue;
      }

      const existingIndex = current.findIndex((item) => item.id === reminder.id);
      if (existingIndex >= 0) {
        current[existingIndex] = {
          ...current[existingIndex],
          ...reminder,
          notificationLeadTimes: normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets),
          markdownPath: "",
        };
        updated += 1;
      } else {
        current.push({
          ...reminder,
          notificationLeadTimes: normalizeNotificationLeadTimes(reminder.notificationLeadTimes, reminder.notificationOffsets),
          markdownPath: "",
        });
        imported += 1;
      }
    }

    write(current);
    return { imported, updated, skipped };
  },
};
