use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;
use crate::ScreentimeExt;

// --- Authorization ---

#[command]
pub(crate) async fn request_authorization<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AuthorizationResponse> {
    app.screentime().request_authorization()
}

#[command]
pub(crate) async fn check_authorization<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AuthorizationResponse> {
    app.screentime().check_authorization()
}

// --- Website Blocking ---

#[command]
pub(crate) async fn block_websites<R: Runtime>(
    app: AppHandle<R>,
    domains: Vec<String>,
) -> Result<BlockWebsitesResponse> {
    app.screentime().block_websites(BlockWebsitesRequest { domains })
}

#[command]
pub(crate) async fn unblock_websites<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SuccessResponse> {
    app.screentime().unblock_websites()
}

// --- App Blocking ---

#[command]
pub(crate) async fn block_apps<R: Runtime>(
    app: AppHandle<R>,
    token_data: Vec<String>,
) -> Result<BlockAppsResponse> {
    app.screentime().block_apps(BlockAppsRequest { token_data })
}

#[command]
pub(crate) async fn unblock_apps<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SuccessResponse> {
    app.screentime().unblock_apps()
}

// --- Combined Block/Unblock ---

#[command]
pub(crate) async fn screentime_start_block<R: Runtime>(
    app: AppHandle<R>,
    payload: StartBlockRequest,
) -> Result<StartBlockResponse> {
    app.screentime().start_block(payload)
}

#[command]
pub(crate) async fn screentime_clear_block<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SuccessResponse> {
    app.screentime().clear_block()
}

// --- Scheduling ---

#[command]
pub(crate) async fn schedule_block<R: Runtime>(
    app: AppHandle<R>,
    id: Option<String>,
    start_hour: u32,
    start_minute: u32,
    end_hour: u32,
    end_minute: u32,
    domains: Option<Vec<String>>,
    app_token_data: Option<Vec<String>>,
    category_token_data: Option<Vec<String>>,
) -> Result<SuccessResponse> {
    app.screentime().schedule_block(ScheduleBlockRequest {
        id,
        start_hour,
        start_minute,
        end_hour,
        end_minute,
        domains,
        app_token_data,
        category_token_data,
    })
}

#[command]
pub(crate) async fn set_schedules<R: Runtime>(
    app: AppHandle<R>,
    schedules: Vec<crate::models::ScheduleEntryRequest>,
) -> Result<SuccessResponse> {
    eprintln!(
        "[ReDD Schedule] Rust command set_schedules called with {} entries",
        schedules.len()
    );
    let result = app.screentime().set_schedules(SetSchedulesRequest {
        schedules,
    });
    match &result {
        Ok(response) => eprintln!(
            "[ReDD Schedule] Rust command set_schedules returned success={}",
            response.success
        ),
        Err(error) => eprintln!(
            "[ReDD Schedule] Rust command set_schedules returned error={}",
            error
        ),
    }
    result
}

#[command]
pub(crate) async fn unschedule_block<R: Runtime>(
    app: AppHandle<R>,
    id: Option<String>,
) -> Result<SuccessResponse> {
    app.screentime().unschedule_block(UnscheduleBlockRequest { id })
}

// --- One-off DeviceActivity (pause resume / block end) ---

#[command]
pub(crate) async fn register_one_off_activity<R: Runtime>(
    app: AppHandle<R>,
    activity_name: String,
    start_timestamp_ms: f64,
) -> Result<SuccessResponse> {
    app.screentime().register_one_off_activity(RegisterOneOffActivityRequest {
        activity_name,
        start_timestamp_ms,
    })
}

#[command]
pub(crate) async fn set_resume_payload<R: Runtime>(
    app: AppHandle<R>,
    block_id: String,
    domains: Vec<String>,
    app_token_data: Option<Vec<String>>,
    category_token_data: Option<Vec<String>>,
) -> Result<SuccessResponse> {
    app.screentime().set_resume_payload(SetResumePayloadRequest {
        block_id,
        domains,
        app_token_data,
        category_token_data,
    })
}

#[command]
pub(crate) async fn set_block_end_state<R: Runtime>(
    app: AppHandle<R>,
    block_id: String,
    domains: Vec<String>,
    app_token_data: Option<Vec<String>>,
    category_token_data: Option<Vec<String>>,
) -> Result<SuccessResponse> {
    app.screentime().set_block_end_state(SetBlockEndStateRequest {
        block_id,
        domains,
        app_token_data,
        category_token_data,
    })
}

// --- Activity Picker ---

#[command]
pub(crate) async fn show_activity_picker<R: Runtime>(
    app: AppHandle<R>,
    initial_application_token_data: Option<Vec<String>>,
    initial_category_token_data: Option<Vec<String>>,
) -> Result<ActivityPickerResponse> {
    app.screentime().show_activity_picker(ActivityPickerRequest {
        initial_application_token_data,
        initial_category_token_data,
    })
}
