use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
#[cfg(not(target_os = "ios"))]
use tauri::WebviewWindow;

/// App data structure - matches the Electron version exactly
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub blocklists: Vec<Blocklist>,
    pub active_blocks: Vec<ActiveBlock>,
    #[serde(default)]
    pub schedules: Vec<Schedule>,
    pub settings: Settings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocklist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub websites: Vec<String>,
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub override_difficulty: Option<OverrideDifficulty>,
    #[serde(default = "default_true")]
    pub show_item_details: bool,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideDifficulty {
    #[serde(rename = "type")]
    pub difficulty_type: String,
    #[serde(default)]
    pub count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_text: Option<String>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBlock {
    pub id: String,
    pub blocklist_id: String,
    pub start_time: u64,
    pub end_time: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause_end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_always_on: Option<bool>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub blocklist_id: String,
    pub segments: Vec<ScheduleSegment>,
    pub repeat_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repeat_date: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pause_end_time: Option<u64>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSegment {
    pub start_hour: u32,
    pub start_minute: u32,
    pub end_hour: u32,
    pub end_minute: u32,
    pub days: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub eula_accepted_revision: Option<u32>,
    #[serde(default)]
    pub eula_accepted_at: Option<u64>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

impl Default for AppData {
    fn default() -> Self {
        Self {
            blocklists: Vec::new(),
            active_blocks: Vec::new(),
            schedules: Vec::new(),
            settings: Settings::default(),
            migration_version: None,
        }
    }
}

fn get_per_user_data_path(app: &AppHandle) -> PathBuf {
    let app_data_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    app_data_dir.join("redd-block-data.json")
}

#[cfg(not(target_os = "ios"))]
fn get_shared_data_path() -> PathBuf {
    get_shared_dir().join("redd-block-data.json")
}

#[cfg(not(target_os = "ios"))]
fn get_shared_helper_state_path() -> PathBuf {
    get_shared_dir().join("helper-state.json")
}

#[cfg(not(target_os = "ios"))]
fn should_use_shared_data_path() -> bool {
    let shared_data_path = get_shared_data_path();
    if shared_data_path.exists() {
        return true;
    }

    let helper_state_path = get_shared_helper_state_path();
    if helper_state_path.exists() {
        return true;
    }

    let shared_dir = get_shared_dir();
    shared_dir.is_dir() && is_dir_writable(&shared_dir)
}

/// Resolve the canonical app-data path.
///
/// On desktop, once shared storage has been activated we keep treating it as the
/// canonical location so installs/uninstalls do not silently flip the app between
/// shared and per-user data files.
///
/// On iOS, the per-user app data dir is always used (single-user device).
/// Public accessor so other command modules can locate the canonical
/// redd-block-data.json without duplicating path selection logic.
pub fn canonical_data_path(app: &AppHandle) -> Option<PathBuf> {
    Some(get_data_path(app))
}

fn get_data_path(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "ios")]
    {
        return get_per_user_data_path(app);
    }

    #[cfg(not(target_os = "ios"))]
    {
        if should_use_shared_data_path() {
            get_shared_data_path()
        } else {
            get_per_user_data_path(app)
        }
    }
}

/// Get the system-wide shared directory (same location as helper-state.json).
#[cfg(not(target_os = "ios"))]
fn get_shared_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let program_data = std::env::var("PROGRAMDATA")
            .unwrap_or_else(|_| "C:\\ProgramData".to_string());
        PathBuf::from(program_data).join("ReDD Block")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/var/lib/redd-block")
    }
}

/// Check if a directory is writable by attempting to create and remove a temp file.
#[cfg(not(target_os = "ios"))]
fn is_dir_writable(dir: &std::path::Path) -> bool {
    let test_path = dir.join(".write-test");
    match fs::write(&test_path, b"test") {
        Ok(_) => {
            let _ = fs::remove_file(&test_path);
            true
        }
        Err(_) => false,
    }
}

/// Set file permissions so all local users can read and write the data file.
#[cfg(not(target_os = "windows"))]
fn set_shared_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    // rw-rw-rw- (0o666) — all users can read and write
    let perms = std::fs::Permissions::from_mode(0o666);
    if let Err(e) = fs::set_permissions(path, perms) {
        log::warn!("Could not set shared permissions on {:?}: {}", path, e);
    }
}

#[cfg(target_os = "windows")]
fn set_shared_permissions(_path: &std::path::Path) {
    // On Windows, %PROGRAMDATA% is already accessible to all users by default.
}

/// Ensure the parent directory for the data file exists.
fn ensure_data_dir(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!("Failed to create data directory {:?}: {}", parent, e)
        })?;
    }
    Ok(())
}

/// Get the app version
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Check for data files from previous per-user locations (migration sources).
///
/// Returns the path to the most recently modified data file found in any of:
/// - Current per-user Tauri app data dir (the old default location)
/// - Legacy bundle identifier directories (com.redd.block, redd-block)
fn find_per_user_data(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Current Tauri app data dir (the old per-user location before shared migration)
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        candidates.push(app_data_dir.join("redd-block-data.json"));
    }

    // Legacy bundle identifiers
    if let Some(app_support) = dirs::data_dir() {
        for id in &["com.redd.block", "redd-block"] {
            candidates.push(app_support.join(id).join("redd-block-data.json"));
        }
    }

    let mut best: Option<(PathBuf, std::time::SystemTime)> = None;
    for path in candidates {
        if path.exists() {
            if let Ok(meta) = fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    if best.as_ref().map_or(true, |(_, t)| modified > *t) {
                        best = Some((path, modified));
                    }
                }
            }
        }
    }

    best.map(|(p, _)| p)
}

fn normalize_eula_state(data: &mut AppData) -> bool {
    let mut changed = false;
    let settings = &mut data.settings;

    if settings.eula_accepted_revision.is_none() {
        let legacy_accepted = settings
            .extra
            .get("eulaAccepted")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if legacy_accepted {
            settings.eula_accepted_revision = Some(1);
            changed = true;
        }
    }

    if settings.eula_accepted_at.is_none() {
        if let Some(raw_accepted_at) = settings.extra.get("eulaAcceptedAt").and_then(|value| value.as_u64()) {
            settings.eula_accepted_at = Some(raw_accepted_at);
            changed = true;
        }
    }

    if settings.extra.remove("eulaAccepted").is_some() {
        changed = true;
    }
    if settings.extra.remove("eulaAcceptedAt").is_some() {
        changed = true;
    }
    if settings.extra.remove("eulaAcceptedRevision").is_some() {
        changed = true;
    }

    changed
}

/// Load data from file
#[tauri::command]
pub fn load_data(app: AppHandle) -> Result<AppData, String> {
    let data_path = get_data_path(&app);
    let per_user_data_path = get_per_user_data_path(&app);

    // Ensure parent directory exists (only needed for per-user fallback path;
    // the shared dir is created by the helper daemon install)
    ensure_data_dir(&data_path)?;

    if data_path.exists() {
        let content = fs::read_to_string(&data_path).map_err(|e| e.to_string())?;
        let mut data: AppData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        if normalize_eula_state(&mut data) {
            let migrated = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
            fs::write(&data_path, &migrated).map_err(|e| e.to_string())?;
            set_shared_permissions(&data_path);
        }
        Ok(data)
    } else {
        // Migrate from per-user location or legacy paths
        if let Some(source_path) = find_per_user_data(&app) {
            if source_path == data_path {
                let content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
                let mut data: AppData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
                if normalize_eula_state(&mut data) {
                    let migrated = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
                    fs::write(&source_path, &migrated).map_err(|e| e.to_string())?;
                    set_shared_permissions(&source_path);
                }
                return Ok(data);
            }

            let destination_kind = if data_path == per_user_data_path {
                "per-user"
            } else {
                "shared"
            };
            log::info!(
                "Migrating data into canonical {} location: {:?} -> {:?}",
                destination_kind,
                source_path,
                data_path
            );
            let content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
            let mut data: AppData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            normalize_eula_state(&mut data);
            // Save to new location so migration only happens once
            let migrated = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
            fs::write(&data_path, &migrated).map_err(|e| e.to_string())?;
            set_shared_permissions(&data_path);
            Ok(data)
        } else {
            Ok(AppData::default())
        }
    }
}

/// Save data to file
#[tauri::command]
pub fn save_data(app: AppHandle, data: AppData) -> Result<(), String> {
    let data_path = get_data_path(&app);

    // Ensure parent directory exists
    ensure_data_dir(&data_path)?;

    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&data_path, &content).map_err(|e| e.to_string())?;
    set_shared_permissions(&data_path);

    #[cfg(target_os = "macos")]
    if let Err(e) = crate::app_group::write_blocklist_bytes(content.as_bytes()) {
        log::warn!("App Group mirror write failed: {}", e);
    }
    Ok(())
}

/// Set window size (used after onboarding) - desktop only
#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn set_window_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    use tauri::LogicalSize;
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    window.center().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set window size - no-op on iOS (always fullscreen)
#[tauri::command]
#[cfg(target_os = "ios")]
pub fn set_window_size(_width: f64, _height: f64) -> Result<(), String> {
    Ok(())
}
