export type ReminderPriority = "low" | "medium" | "high";
export type ReminderStatus = "scheduled" | "snoozed" | "done" | "missed";
export type ReminderItemType = "reminder" | "alarm";

export interface TempoSettings {
  markdownDir: string | null;
  alarmSoundPath: string | null;
  reminderSoundPath: string | null;
  alarmVolume: number;
  reminderVolume: number;
}

export interface Reminder {
  id: string;
  itemType: ReminderItemType;
  title: string;
  notes: string;
  dueAt: string;
  repeatRule: string | null;
  priority: ReminderPriority;
  status: ReminderStatus;
  tags: string[];
  markdownPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderInput {
  itemType: ReminderItemType;
  title: string;
  notes?: string;
  dueAt: string;
  repeatRule?: string | null;
  priority: ReminderPriority;
  tags?: string[];
}

export type ReminderUpdate = Partial<
  Pick<Reminder, "itemType" | "title" | "notes" | "dueAt" | "repeatRule" | "priority" | "status" | "tags">
>;

export interface TempoBackup {
  schemaVersion: 1;
  exportedAt: string;
  reminders: Reminder[];
  settings: TempoSettings;
}

export interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
}
