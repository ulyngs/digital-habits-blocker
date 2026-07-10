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
    /// Blocklist emoji/accent colour, used by the native friction gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// JS-owned pause state; a paused schedule is stored disabled on the
    /// Kotlin side with a WorkManager re-enable at the pause expiry.
    #[serde(default)]
    pub is_paused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_end_timestamp_ms: Option<f64>,
    /// One-shot occurrence window (epoch ms). When set, Kotlin checks
    /// "now within [from, until)" instead of time-of-day + days.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_from_timestamp_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_until_timestamp_ms: Option<f64>,
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
pub struct PermissionsResponse {
    pub accessibility_enabled: bool,
    pub notifications_granted: bool,
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

/// Per-entity enabled/pause snapshot from the Kotlin store, allowing pauses
/// granted by the native activity to be adopted by the shared app state.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStateEntry {
    pub id: String,
    pub is_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled_until: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStatesResponse {
    pub states: Vec<ScheduleStateEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub label: String,
    pub package_name: String,
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
