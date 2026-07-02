use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::commands::SetEventHandlerArgs;
use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AndroidBlocker<R>> {
    Ok(AndroidBlocker(app.clone()))
}

/// Desktop stub — this plugin only ships on Android (see the
/// `target_os = "android"` gate in the app's Cargo.toml). This impl
/// exists solely so `cargo check -p tauri-plugin-android-blocker`
/// works on a developer's desktop machine.
pub struct AndroidBlocker<R: Runtime>(AppHandle<R>);

fn unsupported() -> SuccessResponse {
    SuccessResponse {
        success: false,
        error: Some("Not supported outside Android".to_string()),
    }
}

impl<R: Runtime> AndroidBlocker<R> {
    pub fn check_blocker_permissions(&self) -> crate::Result<PermissionsResponse> {
        Ok(PermissionsResponse {
            accessibility_enabled: false,
            notifications_granted: false,
        })
    }

    pub fn open_accessibility_settings(&self) -> crate::Result<SuccessResponse> {
        Ok(unsupported())
    }

    pub fn set_schedules(&self, _payload: SetSchedulesRequest) -> crate::Result<SuccessResponse> {
        Ok(unsupported())
    }

    pub fn start_manual_block(
        &self,
        _payload: StartManualBlockRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(unsupported())
    }

    pub fn stop_manual_block(
        &self,
        _payload: StopManualBlockRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(unsupported())
    }

    pub fn temporary_unlock(
        &self,
        _payload: TemporaryUnlockRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(unsupported())
    }

    pub fn get_blocking_state(&self) -> crate::Result<BlockingStateResponse> {
        Ok(BlockingStateResponse { schedules: vec![] })
    }

    pub fn read_native_schedules(&self) -> crate::Result<NativeSchedulesResponse> {
        Ok(NativeSchedulesResponse {
            routines_json: "[]".to_string(),
            active_sessions_json: "[]".to_string(),
        })
    }

    pub fn get_installed_apps(&self) -> crate::Result<InstalledAppsResponse> {
        Ok(InstalledAppsResponse { apps: vec![] })
    }

    pub fn set_event_handler(&self, _payload: SetEventHandlerArgs) -> crate::Result<SuccessResponse> {
        Ok(unsupported())
    }
}
