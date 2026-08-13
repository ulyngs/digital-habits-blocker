use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Screentime<R>> {
    Ok(Screentime(app.clone()))
}

/// Desktop stub — Screen Time APIs are iOS-only.
/// macOS uses the browser-extension path instead of Screen Time
/// (the main binary hosts a native-messaging stdio server; Safari
/// routes through `SafariWebExtensionHandler.swift`).
pub struct Screentime<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Screentime<R> {
    pub fn request_authorization(&self) -> crate::Result<AuthorizationResponse> {
        Ok(AuthorizationResponse {
            granted: false,
            status: "unsupported".to_string(),
            error: Some("Screen Time is only available on iOS".to_string()),
        })
    }

    pub fn check_authorization(&self) -> crate::Result<AuthorizationResponse> {
        Ok(AuthorizationResponse {
            granted: false,
            status: "unsupported".to_string(),
            error: Some("Screen Time is only available on iOS".to_string()),
        })
    }

    pub fn block_websites(
        &self,
        _payload: BlockWebsitesRequest,
    ) -> crate::Result<BlockWebsitesResponse> {
        Ok(BlockWebsitesResponse {
            success: false,
            blocked_count: 0,
        })
    }

    pub fn unblock_websites(&self) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn block_apps(&self, _payload: BlockAppsRequest) -> crate::Result<BlockAppsResponse> {
        Ok(BlockAppsResponse {
            success: false,
            blocked_count: 0,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn unblock_apps(&self) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn refresh_activity_tokens(
        &self,
        payload: RefreshActivityTokensRequest,
    ) -> crate::Result<RefreshActivityTokensResponse> {
        Ok(RefreshActivityTokensResponse {
            success: true,
            supported: false,
            application_tokens: payload.application_token_data,
            category_tokens: payload.category_token_data,
            error: None,
        })
    }

    pub fn start_block(&self, _payload: StartBlockRequest) -> crate::Result<StartBlockResponse> {
        Ok(StartBlockResponse {
            success: false,
            websites_blocked: 0,
        })
    }

    pub fn clear_block(&self) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn schedule_block(&self, _payload: ScheduleBlockRequest) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn set_schedules(&self, _payload: SetSchedulesRequest) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn unschedule_block(
        &self,
        _payload: UnscheduleBlockRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Not supported on desktop".to_string()),
        })
    }

    pub fn register_one_off_activity(
        &self,
        _payload: RegisterOneOffActivityRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("One-off DeviceActivity is only available on iOS".to_string()),
        })
    }

    pub fn set_resume_payload(
        &self,
        _payload: SetResumePayloadRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Resume payload is only available on iOS".to_string()),
        })
    }

    pub fn set_block_end_state(
        &self,
        _payload: SetBlockEndStateRequest,
    ) -> crate::Result<SuccessResponse> {
        Ok(SuccessResponse {
            success: false,
            error: Some("Block end state is only available on iOS".to_string()),
        })
    }

    pub fn show_activity_picker(
        &self,
        _payload: ActivityPickerRequest,
    ) -> crate::Result<ActivityPickerResponse> {
        Ok(ActivityPickerResponse {
            cancelled: true,
            application_tokens: vec![],
            category_tokens: vec![],
            application_count: 0,
            category_count: 0,
            error: Some("Activity picker is only available on iOS".to_string()),
        })
    }
}
