# Call-Tracking Android plugin (Capacitor)

Drop-in native plugin that implements the three call pipelines from the Call-Tracking
Blueprint against the server endpoints already built in this repo (`/api/calls/*`):

| Pipeline | Native piece | Server endpoint |
|---|---|---|
| Tap-to-dial | `CallPlugin.dial()` → `ACTION_DIAL` | `POST /api/calls/dial` (called by the web SPA) |
| Call-log import | `CallLogSyncWorker` (hourly WorkManager) reads `CallLog.Calls` | `POST /api/calls/log-sync` |
| Recording sync | `RecordingSyncWorker` (15-min WorkManager) scans the SAF folder | `POST /api/calls/recording-upload` |

> **This is source to add to the Capacitor Android project** (the `android/` Gradle project that
> wraps the web app — it is not part of this server repo, so it cannot be compiled or APK-tested
> here). Files, gradle deps and manifest merges are listed below.

## 1. Files
Copy into `android/app/src/main/java/com/techlingua/crm/calls/`:
`CallPlugin.kt`, `CallLogSyncWorker.kt`, `RecordingSyncWorker.kt`, `ApiClient.kt`.

Copy `js/call-bridge.ts` into the web app (`web/src/`) — it is the typed bridge the SPA imports;
on a browser (no native plugin) it degrades to a `tel:` link so the same code runs everywhere.

## 2. Gradle (`android/app/build.gradle`)
```gradle
dependencies {
    implementation "androidx.work:work-runtime-ktx:2.9.0"
    implementation "com.squareup.okhttp3:okhttp:4.12.0"
    implementation "androidx.documentfile:documentfile:1.0.1"
}
```

## 3. Manifest — merge `AndroidManifest.additions.xml` into `android/app/src/main/AndroidManifest.xml`
Permissions: `READ_CALL_LOG`, `READ_PHONE_STATE`, `CALL_PHONE` (optional; `ACTION_DIAL` needs none),
`POST_NOTIFICATIONS` (WorkManager foreground on 13+), `FOREGROUND_SERVICE`, `INTERNET`.

## 4. Register the plugin
Capacitor 5+ auto-registers `@CapacitorPlugin` classes on the classpath. For older projects add
`add(CallPlugin::class.java)` in `MainActivity.onCreate` before `super`.

## 5. Auth / base URL
The workers read the API base URL and JWT from `SharedPreferences` ("crm_prefs": `api_base`, `jwt`).
The web app writes them after login via `CallBridge.configure({ apiBase, token })` (see `call-bridge.ts`).

## 6. Onboarding / permissions (do this in the app's Call Settings screen)
1. Request `READ_CALL_LOG` + `READ_PHONE_STATE` at runtime.
2. `CallPlugin.pickRecordingFolder()` → SAF tree picker; the granted tree URI is persisted and sent
   to the server as `recording_folder`.
3. Ask the user to exempt the app from battery optimisation (WorkManager reliability).
4. `CallPlugin.startWorkers()` schedules both periodic jobs (intervals come from `/api/calls/settings`).

## Platform realities honoured
- Live `PHONE_STATE` numbers are unreliable on Android 10+, so the number of record is always the
  `CallLog.Calls` provider (written when the call ends) — the server treats live rows as a preview.
- The app never records audio; it only uploads files the OEM dialer already wrote.
- All sync is native WorkManager (survives Doze / WebView death); matching uses time windows, not
  exact timestamps.
