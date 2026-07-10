//! Settings command for the user-configurable browser-extension
//! grace period — the seconds before a non-compliant browser is
//! quit by the enforcer.
//!
//! Anti-circumvention: when at least one block is currently active
//! (manual `activeBlocks` entry whose `endTime` is in the future
//! and isn't paused), the user can DECREASE the grace but not
//! INCREASE it. Otherwise someone could be in the middle of a
//! focus session, slide the grace up to 300 s, and use that window
//! to slip past their own blocks. Decreasing is always allowed
//! (strictly more enforcement, less circumvention).
//!
//! The enforcer reads the value from settings on every grace-start
//! (`enforcer::current_grace`), so changes here take effect
//! immediately for the *next* offense without needing a restart.
//!
//! Schedule-driven blocks are NOT yet considered "active" by this
//! check — only manual ones. A more comprehensive check would
//! evaluate every schedule's segments against `now()`, mirroring
//! the JS `app.js` logic. For now the activeBlocks check covers
//! the immediate-circumvention case (a user in the middle of a
//! focus session can't widen the window).

use serde_json::Value;

use crate::enforcer::{GRACE_MAX_SECS, GRACE_MIN_SECS};

const SETTING_KEY: &str = "extensionGraceSeconds";
const DEFAULT_GRACE_SECS: u64 = 60;

/// Read the current grace setting (clamped to the enforcer's accepted
/// range so the UI never shows a value the enforcer would override).
#[tauri::command]
pub fn get_extension_grace_seconds(app: tauri::AppHandle) -> u64 {
    read_data(&app)
        .and_then(|d| d.get("settings").and_then(|s| s.get(SETTING_KEY)).and_then(|n| n.as_u64()))
        .unwrap_or(DEFAULT_GRACE_SECS)
        .clamp(GRACE_MIN_SECS, GRACE_MAX_SECS)
}

/// Update the grace setting. Returns the new value (post-clamp) on
/// success. Errors with a user-friendly string when an attempted
/// increase is rejected because a block is currently active.
#[tauri::command]
pub fn set_extension_grace_seconds(app: tauri::AppHandle, seconds: u64) -> Result<u64, String> {
    let new = seconds.clamp(GRACE_MIN_SECS, GRACE_MAX_SECS);

    let path = super::canonical_data_path(&app)
        .ok_or_else(|| "no app data path".to_string())?;
    let mut data = read_data(&app).unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    let current = data
        .get("settings")
        .and_then(|s| s.get(SETTING_KEY))
        .and_then(|n| n.as_u64())
        .unwrap_or(DEFAULT_GRACE_SECS);

    if new > current && any_block_currently_active(&data) {
        return Err(format!(
            "Can't increase the grace period while a block is active — only decreases are allowed during a focus session. Current value: {current}s."
        ));
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
        s.insert(SETTING_KEY.to_string(), Value::Number(serde_json::Number::from(new)));
    }

    write_data(&path, &data).map_err(|e| format!("write data: {e}"))?;
    Ok(new)
}

/// True if any `activeBlocks[*]` is in effect right now (start_time
/// already passed, end_time in the future, not paused). Conservative:
/// schedule-driven blocks aren't yet counted — see module-level note.
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
        start <= now_ms && end > now_ms && !paused
    })
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
