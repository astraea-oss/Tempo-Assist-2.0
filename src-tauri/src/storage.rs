use std::{
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose, Engine as _};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoSettings {
    pub markdown_dir: Option<String>,
    pub alarm_sound_path: Option<String>,
    pub reminder_sound_path: Option<String>,
    pub alarm_volume: f64,
    pub reminder_volume: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoSettingsPatch {
    pub markdown_dir: Option<Option<String>>,
    pub alarm_sound_path: Option<Option<String>>,
    pub reminder_sound_path: Option<Option<String>>,
    pub alarm_volume: Option<f64>,
    pub reminder_volume: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub item_type: String,
    pub title: String,
    pub notes: String,
    pub due_at: String,
    pub repeat_rule: Option<String>,
    pub priority: String,
    pub status: String,
    pub tags: Vec<String>,
    pub markdown_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub item_type: String,
    pub title: String,
    pub notes: Option<String>,
    pub due_at: String,
    pub repeat_rule: Option<String>,
    pub priority: String,
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderUpdate {
    pub item_type: Option<String>,
    pub title: Option<String>,
    pub notes: Option<String>,
    pub due_at: Option<String>,
    pub repeat_rule: Option<Option<String>>,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoBackup {
    pub schema_version: u8,
    pub exported_at: String,
    pub reminders: Vec<Reminder>,
    pub settings: Option<TempoSettings>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: u32,
    pub updated: u32,
    pub skipped: u32,
}

pub fn list_reminders_impl() -> Result<Vec<Reminder>, String> {
    let mut reminders = read_reminders()?;
    reminders.sort_by(|a, b| a.due_at.cmp(&b.due_at));
    Ok(reminders)
}

pub fn create_reminder_impl(input: ReminderInput) -> Result<Reminder, String> {
    let mut reminders = read_reminders()?;
    let now = timestamp();
    let mut reminder = Reminder {
        id: Uuid::new_v4().to_string(),
        item_type: normalize_item_type(&input.item_type),
        title: input.title.trim().to_string(),
        notes: input.notes.unwrap_or_default().trim().to_string(),
        due_at: input.due_at,
        repeat_rule: input.repeat_rule,
        priority: input.priority,
        status: "scheduled".to_string(),
        tags: input.tags.unwrap_or_default(),
        markdown_path: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };

    reminder.markdown_path = write_reminder_markdown(&reminder, None)?;
    reminders.push(reminder.clone());
    write_reminders(&reminders)?;
    Ok(reminder)
}

pub fn update_reminder_impl(id: &str, patch: ReminderUpdate) -> Result<Reminder, String> {
    let mut reminders = read_reminders()?;
    let index = reminders
        .iter()
        .position(|reminder| reminder.id == id)
        .ok_or_else(|| format!("Reminder not found: {id}"))?;

    let previous_path = if reminders[index].markdown_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(&reminders[index].markdown_path))
    };

    if let Some(item_type) = patch.item_type {
        reminders[index].item_type = normalize_item_type(&item_type);
    }
    if let Some(title) = patch.title {
        reminders[index].title = title.trim().to_string();
    }
    if let Some(notes) = patch.notes {
        reminders[index].notes = notes.trim().to_string();
    }
    if let Some(due_at) = patch.due_at {
        reminders[index].due_at = due_at;
    }
    if let Some(repeat_rule) = patch.repeat_rule {
        reminders[index].repeat_rule = repeat_rule;
    }
    if let Some(priority) = patch.priority {
        reminders[index].priority = priority;
    }
    if let Some(status) = patch.status {
        reminders[index].status = status;
    }
    if let Some(tags) = patch.tags {
        reminders[index].tags = tags;
    }
    reminders[index].updated_at = timestamp();
    reminders[index].markdown_path = write_reminder_markdown(&reminders[index], previous_path.as_deref())?;

    let updated = reminders[index].clone();
    write_reminders(&reminders)?;
    Ok(updated)
}

pub fn delete_reminder_impl(id: &str) -> Result<(), String> {
    let mut reminders = read_reminders()?;
    if let Some(index) = reminders.iter().position(|reminder| reminder.id == id) {
        let reminder = reminders.remove(index);
        if !reminder.markdown_path.is_empty() {
            let _ = fs::remove_file(reminder.markdown_path);
        }
        write_reminders(&reminders)?;
    }
    Ok(())
}

pub fn get_settings_impl() -> Result<TempoSettings, String> {
    read_settings()
}

pub fn update_settings_impl(patch: TempoSettingsPatch) -> Result<TempoSettings, String> {
    let mut settings = read_settings()?;
    if let Some(markdown_dir) = patch.markdown_dir {
        settings.markdown_dir = normalize_optional_path(markdown_dir);
    }
    if let Some(alarm_sound_path) = patch.alarm_sound_path {
        settings.alarm_sound_path = normalize_optional_path(alarm_sound_path);
    }
    if let Some(reminder_sound_path) = patch.reminder_sound_path {
        settings.reminder_sound_path = normalize_optional_path(reminder_sound_path);
    }
    if let Some(alarm_volume) = patch.alarm_volume {
        settings.alarm_volume = alarm_volume.clamp(0.0, 1.0);
    }
    if let Some(reminder_volume) = patch.reminder_volume {
        settings.reminder_volume = reminder_volume.clamp(0.0, 1.0);
    }
    write_settings(&settings)?;
    Ok(settings)
}

pub fn settings_path_impl() -> Result<String, String> {
    Ok(settings_path()?.display().to_string())
}

pub fn choose_markdown_dir_impl() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose markdown folder")
        .pick_folder()
        .map(|path| path.display().to_string())
}

pub fn choose_sound_file_impl() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose MP3 sound")
        .add_filter("MP3 audio", &["mp3"])
        .pick_file()
        .map(|path| path.display().to_string())
}

pub fn export_backup_impl() -> Result<Option<String>, String> {
    let default_name = format!("tempo-assist-backup-{}.json", Utc::now().date_naive());
    let Some(file_path) = rfd::FileDialog::new()
        .set_title("Export Tempo Assist backup")
        .add_filter("Tempo Assist backup", &["json"])
        .set_file_name(&default_name)
        .save_file()
    else {
        return Ok(None);
    };

    let backup = TempoBackup {
        schema_version: 1,
        exported_at: timestamp(),
        reminders: list_reminders_impl()?,
        settings: Some(read_settings()?),
    };
    let contents = serde_json::to_string_pretty(&backup).map_err(|error| error.to_string())?;
    fs::write(&file_path, contents).map_err(|error| error.to_string())?;
    Ok(Some(file_path.display().to_string()))
}

pub fn import_backup_impl() -> Result<Option<ImportSummary>, String> {
    let Some(file_path) = rfd::FileDialog::new()
        .set_title("Import Tempo Assist backup")
        .add_filter("Tempo Assist backup", &["json"])
        .pick_file()
    else {
        return Ok(None);
    };

    let contents = fs::read_to_string(file_path).map_err(|error| error.to_string())?;
    let backup: TempoBackup = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    if backup.schema_version != 1 {
        return Err("Unsupported Tempo Assist backup file.".to_string());
    }

    if let Some(settings) = backup.settings {
        let _ = update_settings_impl(TempoSettingsPatch {
            alarm_volume: Some(settings.alarm_volume),
            reminder_volume: Some(settings.reminder_volume),
            ..TempoSettingsPatch::default()
        })?;
    }

    import_reminders(backup.reminders).map(Some)
}

pub fn audio_data_url_impl(file_path: &str) -> Result<String, String> {
    let normalized = normalize_path_input(file_path)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "No audio file path set.".to_string())?;
    let path = PathBuf::from(&normalized);
    if !path.exists() {
        return Err(format!("File does not exist: {normalized}"));
    }
    if path.extension().and_then(|value| value.to_str()).map(str::to_lowercase) != Some("mp3".to_string()) {
        return Err(format!("Only .mp3 files are supported right now: {normalized}"));
    }

    let audio = fs::read(path).map_err(|error| error.to_string())?;
    Ok(format!(
        "data:audio/mpeg;base64,{}",
        general_purpose::STANDARD.encode(audio)
    ))
}

fn import_reminders(incoming: Vec<Reminder>) -> Result<ImportSummary, String> {
    let mut current = read_reminders()?;
    let mut imported = 0;
    let mut updated = 0;
    let mut skipped = 0;

    for item in incoming {
        if item.id.trim().is_empty() || item.title.trim().is_empty() || item.due_at.trim().is_empty() {
            skipped += 1;
            continue;
        }

        let existing_index = current.iter().position(|reminder| reminder.id == item.id);
        let previous_path = existing_index
            .and_then(|index| {
                let path = &current[index].markdown_path;
                (!path.is_empty()).then(|| PathBuf::from(path))
            });
        let now = timestamp();
        let mut reminder = Reminder {
            id: item.id,
            item_type: normalize_item_type(&item.item_type),
            title: item.title.trim().to_string(),
            notes: item.notes.trim().to_string(),
            due_at: item.due_at,
            repeat_rule: item.repeat_rule,
            priority: if item.priority.is_empty() {
                "medium".to_string()
            } else {
                item.priority
            },
            status: if item.status.is_empty() {
                "scheduled".to_string()
            } else {
                item.status
            },
            tags: item.tags,
            markdown_path: previous_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            created_at: if item.created_at.is_empty() {
                now.clone()
            } else {
                item.created_at
            },
            updated_at: if item.updated_at.is_empty() {
                now
            } else {
                item.updated_at
            },
        };

        reminder.markdown_path = write_reminder_markdown(&reminder, previous_path.as_deref())?;

        if let Some(index) = existing_index {
            current[index] = reminder;
            updated += 1;
        } else {
            current.push(reminder);
            imported += 1;
        }
    }

    write_reminders(&current)?;
    Ok(ImportSummary {
        imported,
        updated,
        skipped,
    })
}

fn read_reminders() -> Result<Vec<Reminder>, String> {
    let path = reminders_index_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn write_reminders(reminders: &[Reminder]) -> Result<(), String> {
    let path = reminders_index_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let contents = serde_json::to_string_pretty(reminders).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn read_settings() -> Result<TempoSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(default_settings());
    }

    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let Some(frontmatter) = frontmatter(&contents) else {
        return Ok(default_settings());
    };
    let partial: TempoSettingsPatch = serde_yaml::from_str(frontmatter).map_err(|error| error.to_string())?;
    let mut settings = default_settings();
    if let Some(markdown_dir) = partial.markdown_dir {
        settings.markdown_dir = normalize_optional_path(markdown_dir);
    }
    if let Some(alarm_sound_path) = partial.alarm_sound_path {
        settings.alarm_sound_path = normalize_optional_path(alarm_sound_path);
    }
    if let Some(reminder_sound_path) = partial.reminder_sound_path {
        settings.reminder_sound_path = normalize_optional_path(reminder_sound_path);
    }
    if let Some(alarm_volume) = partial.alarm_volume {
        settings.alarm_volume = alarm_volume.clamp(0.0, 1.0);
    }
    if let Some(reminder_volume) = partial.reminder_volume {
        settings.reminder_volume = reminder_volume.clamp(0.0, 1.0);
    }
    Ok(settings)
}

fn write_settings(settings: &TempoSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let yaml = serde_yaml::to_string(settings).map_err(|error| error.to_string())?;
    fs::write(
        path,
        format!("---\n{yaml}---\nEdit these values directly if you prefer.\n"),
    )
    .map_err(|error| error.to_string())
}

fn write_reminder_markdown(reminder: &Reminder, previous_path: Option<&Path>) -> Result<String, String> {
    let file_path = reminder_markdown_path(reminder, previous_path)?;
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let yaml = serde_yaml::to_string(reminder).map_err(|error| error.to_string())?;
    fs::write(&file_path, format!("---\n{yaml}---\n{}", reminder.notes)).map_err(|error| error.to_string())?;
    if let Some(previous_path) = previous_path {
        if previous_path != file_path {
            let _ = fs::remove_file(previous_path);
        }
    }
    Ok(file_path.display().to_string())
}

fn reminder_markdown_path(reminder: &Reminder, previous_path: Option<&Path>) -> Result<PathBuf, String> {
    let reminders_dir = reminders_dir()?;
    let base_name = slugify_title(&reminder.title);
    let title_path = reminders_dir.join(format!("{base_name}.md"));

    if !title_path.exists()
        || same_reminder_file(&title_path, &reminder.id)
        || previous_path.is_some_and(|path| path == title_path)
    {
        return Ok(title_path);
    }

    let id_prefix = reminder.id.chars().take(8).collect::<String>();
    Ok(reminders_dir.join(format!("{base_name}-{id_prefix}.md")))
}

fn same_reminder_file(file_path: &Path, reminder_id: &str) -> bool {
    let Ok(contents) = fs::read_to_string(file_path) else {
        return false;
    };
    let Some(frontmatter) = frontmatter(&contents) else {
        return false;
    };
    let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(frontmatter) else {
        return false;
    };
    value
        .get("id")
        .and_then(|id| id.as_str())
        .is_some_and(|id| id == reminder_id)
}

fn frontmatter(contents: &str) -> Option<&str> {
    let rest = contents.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn reminders_dir() -> Result<PathBuf, String> {
    let settings = read_settings()?;
    let dir = settings
        .markdown_dir
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or(data_root()?.join("reminders"));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn data_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let parent = exe
        .parent()
        .ok_or_else(|| "Unable to resolve executable directory.".to_string())?;
    let root = parent.join("tempo-data");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("settings.md"))
}

fn reminders_index_path() -> Result<PathBuf, String> {
    Ok(data_root()?.join("reminders.json"))
}

fn default_settings() -> TempoSettings {
    TempoSettings {
        markdown_dir: None,
        alarm_sound_path: None,
        reminder_sound_path: None,
        alarm_volume: 0.8,
        reminder_volume: 0.8,
    }
}

fn normalize_path_input(file_path: &str) -> Option<String> {
    let mut normalized = file_path.trim().to_string();
    while (normalized.starts_with('"') && normalized.ends_with('"'))
        || (normalized.starts_with('\'') && normalized.ends_with('\''))
    {
        normalized = normalized[1..normalized.len() - 1].trim().to_string();
    }
    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_optional_path(value: Option<String>) -> Option<String> {
    value.and_then(|path| normalize_path_input(&path))
}

fn normalize_item_type(item_type: &str) -> String {
    if item_type == "alarm" {
        "alarm".to_string()
    } else {
        "reminder".to_string()
    }
}

fn slugify_title(title: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for character in title.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            previous_dash = false;
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "untitled-reminder".to_string()
    } else {
        slug
    }
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
