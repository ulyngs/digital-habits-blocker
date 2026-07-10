//! Settings commands for the browser-enforcement opt-in toggle.
//!
//! The enforcer can force-close browsers that don't have ReDD Focus
//! properly set up (installed, enabled, incognito-allowed) during an
//! active block. This is powerful but jarring for new users who
//! haven't understood the behaviour yet — so enforcement is OFF by
//! default and the user must explicitly opt in via the extension
//! setup dialog.
//!
//! Anti-circumvention: once enforcement is enabled and a block is
//! active, the user CANNOT turn it off until the block expires. The
//! guard is server-side so it can't be bypassed from devtools.

use serde_json::Value;

const SETTING_KEY: &str = "enforcementEnabled";

/// Read the current enforcement-enabled setting from the app data
/// file. Defaults to `false` so new users aren't surprised by
/// automatic browser force-closes.
#[tauri::command]
pub fn get_enforcement_enabled(app: tauri::AppHandle) -> bool {
    read_data(&app)
        .and_then(|d| {
            d.get("settings")
                .and_then(|s| s.get(SETTING_KEY))
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false)
}

/// Enable or disable browser enforcement. Returns the new value on
/// success. Errors when trying to disable enforcement while a block
/// is currently active — the user can't weaken enforcement mid-session.
#[tauri::command]
pub fn set_enforcement_enabled(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let path = super::canonical_data_path(&app)
        .ok_or_else(|| "no app data path".to_string())?;
    let mut data = read_data(&app).unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    // Can't disable enforcement while a block is running.
    if !enabled && (any_block_currently_active(&data) || any_schedule_currently_active(&path)) {
        return Err(
            "Can't turn off browser enforcement while a block is active."
                .to_string(),
        );
    }

    // Apply the new value.
    if !data.is_object() {
        data = Value::Object(serde_json::Map::new());
    }
    let obj = data.as_object_mut().unwrap();
    let settings = obj
        .entry("settings".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Some(s) = settings.as_object_mut() {
        s.insert(SETTING_KEY.to_string(), Value::Bool(enabled));
    }

    write_data(&path, &data).map_err(|e| format!("write data: {e}"))?;
    log::info!("enforcement_toggle: set enforcementEnabled = {enabled}");
    Ok(enabled)
}

/// True if any `activeBlocks[*]` is in effect right now. Mirrors the
/// logic in `grace.rs::any_block_currently_active`.
fn any_block_currently_active(data: &Value) -> bool {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let blocks = match data.get("activeBlocks").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return false,
    };
    blocks.iter().any(|b| {
        let start = b.get("startTime").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
        let end = b.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let paused = b.get("isPaused").and_then(|v| v.as_bool()).unwrap_or(false);
        // "Always" blocks have endTime = null → deserialized as 0 or
        // missing. Treat null/0 endTime as "infinite" so they count
        // as active.
        let is_always = b.get("endTime").map_or(true, |v| v.is_null());
        start <= now_ms && (is_always || end > now_ms) && !paused
    })
}

/// True if any schedule segment is actively feeding the browser extension.
/// `native_host::derive_payload` is the source of truth used by the
/// extension itself, so this catches schedule-driven website blocks.
fn any_schedule_currently_active(data_path: &std::path::Path) -> bool {
    let (_domains, blocks) = crate::native_host::derive_payload(data_path);
    blocks.iter().any(|b| b.source == "schedule")
}

fn read_data(app: &tauri::AppHandle) -> Option<Value> {
    let path = super::canonical_data_path(app)?;
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_data(path: &std::path::Path, data: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(data)?;
    super::data::write_data_file_atomic(path, &body)
}
