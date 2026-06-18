#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;

use storage::{
    audio_data_url_impl, choose_markdown_dir_impl, choose_sound_file_impl, create_reminder_impl,
    delete_reminder_impl, export_backup_impl, get_settings_impl, import_backup_impl,
    list_reminders_impl, settings_path_impl, update_reminder_impl, update_settings_impl,
    Reminder, ReminderInput, ReminderUpdate, TempoSettings, TempoSettingsPatch,
};

#[tauri::command]
fn list_reminders() -> Result<Vec<Reminder>, String> {
    list_reminders_impl()
}

#[tauri::command]
fn create_reminder(input: ReminderInput) -> Result<Reminder, String> {
    create_reminder_impl(input)
}

#[tauri::command]
fn update_reminder(id: String, patch: ReminderUpdate) -> Result<Reminder, String> {
    update_reminder_impl(&id, patch)
}

#[tauri::command]
fn delete_reminder(id: String) -> Result<(), String> {
    delete_reminder_impl(&id)
}

#[tauri::command]
fn get_settings() -> Result<TempoSettings, String> {
    get_settings_impl()
}

#[tauri::command]
fn update_settings(patch: TempoSettingsPatch) -> Result<TempoSettings, String> {
    update_settings_impl(patch)
}

#[tauri::command]
fn settings_path() -> Result<String, String> {
    settings_path_impl()
}

#[tauri::command]
fn choose_markdown_dir() -> Option<String> {
    choose_markdown_dir_impl()
}

#[tauri::command]
fn choose_sound_file() -> Option<String> {
    choose_sound_file_impl()
}

#[tauri::command]
fn export_backup() -> Result<Option<String>, String> {
    export_backup_impl()
}

#[tauri::command]
fn import_backup() -> Result<Option<storage::ImportSummary>, String> {
    import_backup_impl()
}

#[tauri::command(rename_all = "camelCase")]
fn audio_data_url(file_path: String) -> Result<String, String> {
    audio_data_url_impl(&file_path)
}

#[tauri::command]
fn test_alarm(_title: String) {}

#[tauri::command]
fn window_minimize(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn window_toggle_maximize(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn window_close(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_reminders,
            create_reminder,
            update_reminder,
            delete_reminder,
            get_settings,
            update_settings,
            settings_path,
            choose_markdown_dir,
            choose_sound_file,
            export_backup,
            import_backup,
            audio_data_url,
            test_alarm,
            window_minimize,
            window_toggle_maximize,
            window_close
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Tempo Assist");
}
