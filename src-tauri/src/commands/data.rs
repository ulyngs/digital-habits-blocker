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
    #[serde(default)]
    pub start_overlays: Vec<NamedScheduleStartOverlay>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStartOverlay {
    #[serde(default)]
    pub custom: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lets_go_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedScheduleStartOverlay {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lets_go_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heading: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_overlay_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_overlay: Option<ScheduleStartOverlay>,
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
            start_overlays: Vec::new(),
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

#[cfg(target_os = "windows")]
fn get_windows_primary_shared_dir() -> PathBuf {
    let program_data = std::env::var("PROGRAMDATA")
        .unwrap_or_else(|_| "C:\\ProgramData".to_string());
    PathBuf::from(program_data).join("ReDD Blocker")
}

#[cfg(target_os = "windows")]
fn get_windows_legacy_shared_dirs() -> [PathBuf; 2] {
    let program_data = std::env::var("PROGRAMDATA")
        .unwrap_or_else(|_| "C:\\ProgramData".to_string());
    let root = PathBuf::from(program_data);
    [root.join("Fristed"), root.join("ReDD Block")]
}

#[cfg(target_os = "windows")]
fn get_windows_legacy_shared_data_path() -> PathBuf {
    get_windows_legacy_shared_dirs()[0].join("redd-block-data.json")
}

#[cfg(target_os = "windows")]
fn get_windows_legacy_helper_state_path() -> PathBuf {
    get_windows_legacy_shared_dirs()[0].join("helper-state.json")
}

#[cfg(target_os = "windows")]
fn migrate_windows_shared_storage_copy() {
    let primary_dir = get_windows_primary_shared_dir();

    if let Err(e) = fs::create_dir_all(&primary_dir) {
        log::warn!(
            "windows shared storage migration: failed to create {}: {e}",
            primary_dir.display()
        );
        return;
    }

    for legacy_dir in get_windows_legacy_shared_dirs() {
        if !legacy_dir.exists() {
            continue;
        }

        for name in ["redd-block-data.json", "helper-state.json"] {
            let src = legacy_dir.join(name);
            let dst = primary_dir.join(name);
            if !src.exists() || dst.exists() {
                continue;
            }
            match fs::copy(&src, &dst) {
                Ok(_) => {
                    log::info!(
                        "windows shared storage migration: copied {} -> {}",
                        src.display(),
                        dst.display()
                    );
                }
                Err(e) => {
                    log::warn!(
                        "windows shared storage migration: failed to copy {} -> {}: {e}",
                        src.display(),
                        dst.display()
                    );
                }
            }
        }
    }
}

#[cfg(not(target_os = "ios"))]
fn should_use_shared_data_path() -> bool {
    #[cfg(target_os = "windows")]
    migrate_windows_shared_storage_copy();

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

/// Same path selection as [`canonical_data_path`] but without an
/// [`AppHandle`]. Used by macOS startup gating (`cross_app_consent`)
/// before the frontend has loaded — must NOT scan legacy bundle-id
/// paths, only the canonical shared or per-user location.
#[cfg(not(target_os = "ios"))]
pub fn canonical_data_path_static() -> PathBuf {
    if should_use_shared_data_path() {
        get_shared_data_path()
    } else {
        per_user_data_path_static()
    }
}

#[cfg(not(target_os = "ios"))]
fn per_user_data_path_static() -> PathBuf {
    dirs::data_dir()
        .map(|d| d.join("com.reddblock").join("redd-block-data.json"))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_default()
                .join("Library/Application Support/com.reddblock/redd-block-data.json")
        })
}

pub(crate) fn get_data_path(app: &AppHandle) -> PathBuf {
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
        get_windows_primary_shared_dir()
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

/// Atomically replace the data file: write to a temp file in the same
/// directory, apply shared permissions, then rename over the destination.
///
/// The data file is the single source of truth for active blocking and
/// is re-read continuously by other threads and processes — the
/// Automation watcher (1 s tick), the browser-spawned native host (2 s
/// mtime poll), and the enforcer (5 s tick). A plain truncate-and-write
/// can be observed half-written; the readers then fail the JSON parse
/// and treat the blocklist as empty, momentarily dropping enforcement
/// (and un-parking tabs from the block page). rename() within one
/// directory is atomic on APFS and NTFS, so readers see either the old
/// or the new complete file, never a torn one.
pub(crate) fn write_data_file_atomic(
    path: &std::path::Path,
    contents: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Unique per process AND per call — concurrent Tauri commands may
    // save from different threads of the same process.
    static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("redd-block-data.json");
    let tmp = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        // Flush to disk before the rename so a crash can't leave the
        // canonical path pointing at a not-yet-persisted temp file.
        file.sync_all()?;
        drop(file);
        // The rename gives the destination the temp file's permissions,
        // so the shared-file mode must be applied before the swap.
        set_shared_permissions(&tmp);
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
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

/// True when this process is running from a Microsoft Store (MSIX) package.
/// Store users receive updates via the Store, not reddfocus.org installers.
#[tauri::command]
pub fn is_microsoft_store_package() -> bool {
    #[cfg(target_os = "windows")]
    {
        std::env::current_exe()
            .map(|p| crate::native_host_install::is_msix_packaged_exe_path(&p))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
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
            write_data_file_atomic(&data_path, migrated.as_bytes()).map_err(|e| e.to_string())?;
        }
        // The app-watcher registration loop already reads this file as soon
        // as it starts and then every two seconds. Avoid repeating that work
        // synchronously on the frontend's first data request: load_data is on
        // the first-render critical path.
        Ok(data)
    } else {
        // Migrate from per-user location or legacy paths
        if let Some(source_path) = find_per_user_data(&app) {
            if source_path == data_path {
                let content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
                let mut data: AppData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
                if normalize_eula_state(&mut data) {
                    let migrated = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
                    write_data_file_atomic(&source_path, migrated.as_bytes())
                        .map_err(|e| e.to_string())?;
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
            write_data_file_atomic(&data_path, migrated.as_bytes()).map_err(|e| e.to_string())?;
            Ok(data)
        } else {
            Ok(AppData::default())
        }
    }
}

/// Save data to file
#[tauri::command]
pub fn save_data(app: AppHandle, mut data: AppData) -> Result<(), String> {
    let data_path = get_data_path(&app);

    // Ensure parent directory exists
    ensure_data_dir(&data_path)?;

    // Backend-managed settings keys: these are owned by dedicated
    // commands (set_enforcement_enabled, set_extension_grace_seconds)
    // that read-modify-write the JSON directly. The frontend never
    // touches them in `appData.settings`, so a blind round-trip here
    // would drop a fresh-install user's toggle a few seconds after
    // they enabled it (the next saveData() trigger — block edit,
    // tick, etc. — serializes the stale `undefined` and clobbers
    // the disk value written by the dedicated command). Preserve
    // whatever is currently on disk for these keys.
    preserve_backend_settings(&data_path, &mut data);

    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    write_data_file_atomic(&data_path, content.as_bytes()).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    crate::app_group::maybe_mirror_after_save(&data_path, content.as_bytes());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    super::app_blocking::sync_blocked_apps_from_disk(&app);

    Ok(())
}

const BACKEND_MANAGED_SETTING_KEYS: &[&str] = &[
    "enforcementEnabled",
    "extensionGraceSeconds",
    "blockingMethods",
];

fn preserve_backend_settings(data_path: &std::path::Path, data: &mut AppData) {
    let raw = match fs::read_to_string(data_path) {
        Ok(s) => s,
        Err(_) => return,
    };
    let disk: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
    };
    let disk_settings = match disk.get("settings").and_then(|s| s.as_object()) {
        Some(s) => s,
        None => return,
    };
    for key in BACKEND_MANAGED_SETTING_KEYS {
        if let Some(value) = disk_settings.get(*key) {
            data.settings.extra.insert((*key).to_string(), value.clone());
        } else {
            data.settings.extra.remove(*key);
        }
    }
}

/// Set window size (used after onboarding) - desktop only
#[tauri::command]
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub fn set_window_size(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    use tauri::LogicalSize;
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    window.center().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set window size - no-op on mobile (always fullscreen)
#[tauri::command]
#[cfg(any(target_os = "ios", target_os = "android"))]
pub fn set_window_size(_width: f64, _height: f64) -> Result<(), String> {
    Ok(())
}

/// Remove blocklists, schedules, settings, and related on-disk state.
/// Best-effort: logs and continues when individual paths are missing or
/// not writable. Logs are intentionally preserved.
#[cfg(not(target_os = "ios"))]
pub fn wipe_user_data(app: &AppHandle) {
    use std::collections::HashSet;

    #[cfg(target_os = "macos")]
    {
        if let Err(e) = crate::app_group::remove_blocklist_mirror() {
            log::warn!("wipe_user_data: App Group mirror cleanup failed: {e}");
        }
    }

    let mut files: Vec<PathBuf> = vec![get_data_path(app)];

    if let Ok(app_data_dir) = app.path().app_data_dir() {
        files.push(app_data_dir.join("redd-block-data.json"));
    }

    if let Some(data_dir) = dirs::data_dir() {
        files.push(data_dir.join("com.reddblock").join("redd-block-data.json"));
        for id in ["com.redd.block", "redd-block"] {
            files.push(data_dir.join(id).join("redd-block-data.json"));
        }
    }

    let shared_dir = get_shared_dir();
    files.push(shared_dir.join("redd-block-data.json"));
    files.push(shared_dir.join("helper-state.json"));

    #[cfg(target_os = "windows")]
    {
        for legacy_dir in get_windows_legacy_shared_dirs() {
            files.push(legacy_dir.join("redd-block-data.json"));
            files.push(legacy_dir.join("helper-state.json"));
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        files.push(home.join("Library/Preferences/com.reddblock.plist"));
    }

    let mut dirs: HashSet<PathBuf> = HashSet::new();
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        dirs.insert(app_data_dir);
    }
    if let Some(data_dir) = dirs::data_dir() {
        dirs.insert(data_dir.join("com.reddblock"));
        for id in ["com.redd.block", "redd-block"] {
            dirs.insert(data_dir.join(id));
        }
    }

    for path in files {
        wipe_path(&path);
    }
    for dir in dirs {
        wipe_path(&dir);
    }
}

#[cfg(not(target_os = "ios"))]
fn wipe_path(path: &PathBuf) {
    if !path.exists() {
        return;
    }
    let result = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    if let Err(e) = result {
        log::warn!("wipe_user_data: failed to remove {}: {e}", path.display());
    } else {
        log::info!("wipe_user_data: removed {}", path.display());
    }
}
