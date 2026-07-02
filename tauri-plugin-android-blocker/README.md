# Tauri Plugin android-blocker

Thin Rust/Kotlin bridge exposing the Android blocking engine (originally
`redd-block-android`) to the shared webview UI. All blocking logic —
`BlockerService` (AccessibilityService), `Schedules`, `ScheduleManager`,
WorkManager re-enable/stop-session jobs — lives in `android/` under its
original `net.kollnig.reddblockandroid.*` package names and runs
independently of the webview process. Rust only marshals commands and
events; it does no background work, by design (battery-drain concern
with running Rust logic on Android).

Android-only: gated behind `target_os = "android"` in the app's
`Cargo.toml`, mirroring how `tauri-plugin-screentime` is iOS-only.
