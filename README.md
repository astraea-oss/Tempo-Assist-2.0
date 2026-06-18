# Tempo Assist

Portable Tauri + React reminder, alarm, calendar, and focus timer app.

## Run

```bash
npm install
npm run dev
```

## Build Portable EXE

```bash
npm run build
```

The build uses `tauri build --no-bundle`, so it produces a raw executable instead of an installer. Runtime data is stored in a `tempo-data` folder beside the running executable:

```text
Tempo Assist.exe
tempo-data/
  settings.md
  reminders.json
  reminders/
    <reminder-title>.md
```

The app does not use AppData for its default storage.
