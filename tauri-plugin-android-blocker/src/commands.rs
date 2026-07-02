use serde::Serialize;
use tauri::{command, ipc::Channel, AppHandle, Runtime};

use crate::models::*;
use crate::AndroidBlockerExt;
use crate::Result;

#[command]
pub(crate) async fn check_blocker_permissions<R: Runtime>(
    app: AppHandle<R>,
) -> Result<PermissionsResponse> {
    app.android_blocker().check_blocker_permissions()
}

#[command]
pub(crate) async fn open_accessibility_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SuccessResponse> {
    app.android_blocker().open_accessibility_settings()
}

#[command]
pub(crate) async fn set_schedules<R: Runtime>(
    app: AppHandle<R>,
    schedules: Vec<ScheduleEntry>,
) -> Result<SuccessResponse> {
    app.android_blocker()
        .set_schedules(SetSchedulesRequest { schedules })
}

#[command]
pub(crate) async fn start_manual_block<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    end_timestamp_ms: Option<f64>,
) -> Result<SuccessResponse> {
    app.android_blocker()
        .start_manual_block(StartManualBlockRequest { id, end_timestamp_ms })
}

#[command]
pub(crate) async fn stop_manual_block<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<SuccessResponse> {
    app.android_blocker()
        .stop_manual_block(StopManualBlockRequest { id })
}

#[command]
pub(crate) async fn temporary_unlock<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<SuccessResponse> {
    app.android_blocker()
        .temporary_unlock(TemporaryUnlockRequest { id })
}

#[command]
pub(crate) async fn get_blocking_state<R: Runtime>(
    app: AppHandle<R>,
) -> Result<BlockingStateResponse> {
    app.android_blocker().get_blocking_state()
}

#[command]
pub(crate) async fn read_native_schedules<R: Runtime>(
    app: AppHandle<R>,
) -> Result<NativeSchedulesResponse> {
    app.android_blocker().read_native_schedules()
}

#[command]
pub(crate) async fn get_installed_apps<R: Runtime>(
    app: AppHandle<R>,
) -> Result<InstalledAppsResponse> {
    app.android_blocker().get_installed_apps()
}

// `Channel` only implements `Serialize` (it's a live IPC handle, not a
// plain data type) — deriving `Deserialize`/`Debug` here would fail, and
// this struct is only ever constructed host-side to hand to
// `run_mobile_plugin`, never deserialized.
#[derive(Serialize)]
pub struct SetEventHandlerArgs {
    pub handler: Channel<FrictionGateEvent>,
}

/// Registers the webview's `listen('friction-gate', ...)` channel with
/// the Kotlin plugin so `BlockerService` can push an event when it
/// intercepts a blocked app/website and launches the main activity.
/// Internal-only — not exposed as a public JS-facing command surface
/// beyond `invoke('plugin:android-blocker|set_event_handler', ...)`.
#[command]
pub(crate) async fn set_event_handler<R: Runtime>(
    app: AppHandle<R>,
    handler: Channel<FrictionGateEvent>,
) -> Result<SuccessResponse> {
    app.android_blocker()
        .set_event_handler(SetEventHandlerArgs { handler })
}
