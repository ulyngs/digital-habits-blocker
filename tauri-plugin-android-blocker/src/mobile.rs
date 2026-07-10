use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

// Must match `package net.kollnig.reddblockandroid.plugin` in BlockerPlugin.kt.
// register_android_plugin resolves the class as "$PLUGIN_IDENTIFIER.$className"
// (see WryActivity.getAppClass) — passing "" produced the invalid name
// ".BlockerPlugin" and crashed the app on startup.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "net.kollnig.reddblockandroid.plugin";

// initializes the Kotlin plugin class
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AndroidBlocker<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "BlockerPlugin")?;
    Ok(AndroidBlocker(handle))
}

/// Access to the Kotlin `BlockerPlugin` — a thin marshaling layer only.
/// All blocking logic (AccessibilityService, WorkManager) runs entirely
/// in Kotlin, independently of this Rust process, so nothing here does
/// background work.
pub struct AndroidBlocker<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AndroidBlocker<R> {
    pub fn check_blocker_permissions(&self) -> crate::Result<PermissionsResponse> {
        self.0
            .run_mobile_plugin("checkBlockerPermissions", ())
            .map_err(Into::into)
    }

    pub fn open_accessibility_settings(&self) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("openAccessibilitySettings", ())
            .map_err(Into::into)
    }

    pub fn set_schedules(&self, payload: SetSchedulesRequest) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("setSchedules", payload)
            .map_err(Into::into)
    }

    pub fn start_manual_block(
        &self,
        payload: StartManualBlockRequest,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("startManualBlock", payload)
            .map_err(Into::into)
    }

    pub fn stop_manual_block(
        &self,
        payload: StopManualBlockRequest,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("stopManualBlock", payload)
            .map_err(Into::into)
    }

    pub fn read_native_schedules(&self) -> crate::Result<NativeSchedulesResponse> {
        self.0
            .run_mobile_plugin("readNativeSchedules", ())
            .map_err(Into::into)
    }

    pub fn get_schedule_states(&self) -> crate::Result<ScheduleStatesResponse> {
        self.0
            .run_mobile_plugin("getScheduleStates", ())
            .map_err(Into::into)
    }

    pub fn get_cached_installed_apps(&self) -> crate::Result<InstalledAppsResponse> {
        self.0
            .run_mobile_plugin("getCachedInstalledApps", ())
            .map_err(Into::into)
    }

    pub fn get_installed_apps(&self) -> crate::Result<InstalledAppsResponse> {
        self.0
            .run_mobile_plugin("getInstalledApps", ())
            .map_err(Into::into)
    }

    pub fn set_event_handler(
        &self,
        payload: crate::commands::SetEventHandlerArgs,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("setEventHandler", payload)
            .map_err(Into::into)
    }
}
