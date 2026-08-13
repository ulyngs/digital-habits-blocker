use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_screentime);

// initializes the Swift plugin class
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Screentime<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("", "ScreentimePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_screentime)?;
    Ok(Screentime(handle))
}

/// Access to the Screen Time APIs via the native Swift plugin.
pub struct Screentime<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Screentime<R> {
    // --- Authorization ---

    pub fn request_authorization(&self) -> crate::Result<AuthorizationResponse> {
        self.0
            .run_mobile_plugin("requestAuthorization", AuthorizationRequest {})
            .map_err(Into::into)
    }

    pub fn check_authorization(&self) -> crate::Result<AuthorizationResponse> {
        self.0
            .run_mobile_plugin("checkAuthorization", AuthorizationRequest {})
            .map_err(Into::into)
    }

    // --- Website Blocking ---

    pub fn block_websites(
        &self,
        payload: BlockWebsitesRequest,
    ) -> crate::Result<BlockWebsitesResponse> {
        self.0
            .run_mobile_plugin("blockWebsites", payload)
            .map_err(Into::into)
    }

    pub fn unblock_websites(&self) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("unblockWebsites", UnblockRequest {})
            .map_err(Into::into)
    }

    // --- App Blocking ---

    pub fn block_apps(&self, payload: BlockAppsRequest) -> crate::Result<BlockAppsResponse> {
        self.0
            .run_mobile_plugin("blockApps", payload)
            .map_err(Into::into)
    }

    pub fn unblock_apps(&self) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("unblockApps", UnblockRequest {})
            .map_err(Into::into)
    }

    pub fn refresh_activity_tokens(
        &self,
        payload: RefreshActivityTokensRequest,
    ) -> crate::Result<RefreshActivityTokensResponse> {
        self.0
            .run_mobile_plugin("refreshActivityTokens", payload)
            .map_err(Into::into)
    }

    // --- Combined Block/Unblock (matches existing frontend API) ---

    pub fn start_block(&self, payload: StartBlockRequest) -> crate::Result<StartBlockResponse> {
        self.0
            .run_mobile_plugin("startBlock", payload)
            .map_err(Into::into)
    }

    pub fn clear_block(&self) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("clearBlock", UnblockRequest {})
            .map_err(Into::into)
    }

    // --- Scheduling ---

    pub fn schedule_block(&self, payload: ScheduleBlockRequest) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("scheduleBlock", payload)
            .map_err(Into::into)
    }

    pub fn set_schedules(&self, payload: SetSchedulesRequest) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("setSchedules", payload)
            .map_err(Into::into)
    }

    pub fn unschedule_block(
        &self,
        payload: UnscheduleBlockRequest,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("unscheduleBlock", payload)
            .map_err(Into::into)
    }

    // --- One-off DeviceActivity (pause resume / block end) ---

    pub fn register_one_off_activity(
        &self,
        payload: RegisterOneOffActivityRequest,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("registerOneOffActivity", payload)
            .map_err(Into::into)
    }

    pub fn set_resume_payload(
        &self,
        payload: SetResumePayloadRequest,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("setResumePayload", payload)
            .map_err(Into::into)
    }

    pub fn set_block_end_state(
        &self,
        payload: SetBlockEndStateRequest,
    ) -> crate::Result<SuccessResponse> {
        self.0
            .run_mobile_plugin("setBlockEndState", payload)
            .map_err(Into::into)
    }

    // --- Activity Picker ---

    pub fn show_activity_picker(
        &self,
        payload: ActivityPickerRequest,
    ) -> crate::Result<ActivityPickerResponse> {
        self.0
            .run_mobile_plugin("showActivityPicker", payload)
            .map_err(Into::into)
    }
}
