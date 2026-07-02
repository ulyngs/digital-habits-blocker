use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuccessResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One schedule as synced from the webview's data model. Mirrors the
/// Kotlin `Schedule` data class (`net.kollnig.reddblockandroid.data.Schedule`)
/// closely enough that `BlockerPlugin.setSchedules` can convert 1:1.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// "MANUAL" | "DAILY" | "WEEKLY"
    #[serde(rename = "type")]
    pub schedule_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_hour: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_minute: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_hour: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_minute: Option<u32>,
    /// Full uppercase `java.time.DayOfWeek` names, e.g. "MONDAY".
    #[serde(default)]
    pub days: Vec<String>,
    #[serde(default)]
    pub blocked_apps: Vec<String>,
    #[serde(default)]
    pub blocked_websites: Vec<String>,
    pub friction_word_count: u32,
    pub auto_reenable_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSchedulesRequest {
    pub schedules: Vec<ScheduleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartManualBlockRequest {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_timestamp_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopManualBlockRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryUnlockRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionsResponse {
    pub accessibility_enabled: bool,
    pub notifications_granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingStateEntry {
    pub id: String,
    pub is_active_now: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled_until: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockingStateResponse {
    pub schedules: Vec<BlockingStateEntry>,
}

/// Raw prefs JSON, exposed once for the one-time upward migration into
/// the webview's own data model (`read_native_schedules`). See
/// `Schedules.kt`'s `routines` / `active_routine_sessions` keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSchedulesResponse {
    pub routines_json: String,
    pub active_sessions_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub label: String,
    pub package_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppsResponse {
    pub apps: Vec<InstalledApp>,
}

/// Payload for the Kotlin -> JS `friction-gate` event, fired when
/// `BlockerService` intercepts a blocked app/website and launches the
/// main activity so the webview can show the override-challenge UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrictionGateEvent {
    pub schedule_id: String,
    pub schedule_name: String,
    pub blocked_target: String,
}
