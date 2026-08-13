use serde::{Deserialize, Serialize};

// --- Authorization ---

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthorizationRequest {}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationResponse {
    pub granted: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Website Blocking ---

#[derive(Debug, Serialize, Deserialize)]
pub struct BlockWebsitesRequest {
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockWebsitesResponse {
    pub success: bool,
    #[serde(default)]
    pub blocked_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UnblockRequest {}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SuccessResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- App Blocking ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockAppsRequest {
    pub token_data: Vec<String>, // Base64-encoded ApplicationToken data
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockAppsResponse {
    pub success: bool,
    #[serde(default)]
    pub blocked_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshActivityTokensRequest {
    pub application_token_data: Vec<String>,
    pub category_token_data: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshActivityTokensResponse {
    pub success: bool,
    pub supported: bool,
    #[serde(default)]
    pub application_tokens: Vec<String>,
    #[serde(default)]
    pub category_tokens: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// --- Combined Block (matches existing frontend API) ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBlockRequest {
    /// Legacy field: domains to BLOCK (blocklist semantics). Kept for back-compat.
    pub domains: Vec<String>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// Pre-resolved blocked/allowed split of the active manual union. When
    /// allowed_* fields are present, Swift applies `.all(except:)` semantics.
    /// All optional so older payloads decode unchanged.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub blocked_domains: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_domains: Option<Vec<String>>,
    #[serde(default)]
    pub blocked_app_token_data: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_app_token_data: Option<Vec<String>>,
    /// Blocklist label for shield copy; omit on older clients.
    #[serde(default)]
    pub blocklist_emoji: Option<String>,
    #[serde(default)]
    pub blocklist_name: Option<String>,
    #[serde(default)]
    pub blocklist_color_hex: Option<String>,
    #[serde(default)]
    pub block_start_ms: Option<f64>,
    #[serde(default)]
    pub block_end_ms: Option<f64>,
    /// Shield-attribution display fields for the earliest-started active
    /// allow-mode block (the fields above describe the overall display winner,
    /// which may be a blocklist block). Omit when no allowlist block is active.
    #[serde(default)]
    pub allowlist_blocklist_emoji: Option<String>,
    #[serde(default)]
    pub allowlist_blocklist_name: Option<String>,
    #[serde(default)]
    pub allowlist_blocklist_color_hex: Option<String>,
    #[serde(default)]
    pub allowlist_block_start_ms: Option<f64>,
    #[serde(default)]
    pub allowlist_block_end_ms: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBlockResponse {
    pub success: bool,
    #[serde(default)]
    pub websites_blocked: usize,
}

// --- Scheduling ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleBlockRequest {
    pub id: Option<String>,
    pub start_hour: u32,
    pub start_minute: u32,
    pub end_hour: u32,
    pub end_minute: u32,
    pub domains: Option<Vec<String>>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntryRequest {
    pub id: String,
    pub start_hour: u32,
    pub start_minute: u32,
    pub end_hour: u32,
    pub end_minute: u32,
    pub domains: Option<Vec<String>>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// Optional weekday filter: Mon=0 … Sun=6. If present, extension only applies when current day is in this list.
    pub days: Option<Vec<u8>>,
    /// Whether the DeviceActivity schedule should repeat.
    pub repeats: Option<bool>,
    /// Optional active window start for this schedule entry.
    pub active_from_timestamp_ms: Option<f64>,
    /// Optional active window end for this schedule entry.
    pub active_until_timestamp_ms: Option<f64>,
    /// Whether this schedule entry is currently paused.
    pub is_paused: Option<bool>,
    /// Optional pause expiry for this schedule entry.
    pub pause_end_timestamp_ms: Option<f64>,
    /// Optional blocklist presentation for shield snapshot.
    pub blocklist_emoji: Option<String>,
    pub blocklist_name: Option<String>,
    pub blocklist_color_hex: Option<String>,
    /// "allowlist" when this entry's domains/tokens are ALLOWED items;
    /// absent/"blocklist" = blocked items (legacy semantics).
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSchedulesRequest {
    pub schedules: Vec<ScheduleEntryRequest>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnscheduleBlockRequest {
    pub id: Option<String>,
}

// --- One-off DeviceActivity (pause resume / block end) ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOneOffActivityRequest {
    pub activity_name: String,
    pub start_timestamp_ms: f64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetResumePayloadRequest {
    pub block_id: String,
    pub domains: Vec<String>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// "allowlist" when this payload's items are ALLOWED items.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBlockEndStateRequest {
    pub block_id: String,
    pub domains: Vec<String>,
    pub app_token_data: Option<Vec<String>>,
    pub category_token_data: Option<Vec<String>>,
    /// "allowlist" when this payload's items are ALLOWED items.
    #[serde(default)]
    pub mode: Option<String>,
}

// --- Activity Picker ---

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPickerRequest {
    pub initial_application_token_data: Option<Vec<String>>,
    pub initial_category_token_data: Option<Vec<String>>,
    /// "allowlist" when picking for an allow-mode focus space — the iOS picker
    /// then expands category picks into individual member app tokens.
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPickerResponse {
    pub cancelled: bool,
    #[serde(default)]
    pub application_tokens: Vec<String>,
    #[serde(default)]
    pub category_tokens: Vec<String>,
    #[serde(default)]
    pub application_count: usize,
    #[serde(default)]
    pub category_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
