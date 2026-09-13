use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
// Only `set_window_size` needs this, and that command is desktop-only.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use tauri::WebviewWindow;
use tauri::{AppHandle, Manager};

/// App data structure - matches the Electron version exactly
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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

/// Name of the data file in every location it has ever lived.
pub(crate) const DATA_FILE_NAME: &str = "redd-block-data.json";

/// Per-user directory name — the Tauri bundle identifier, so this
/// matches `app_data_dir()` for handle-free callers.
const APP_DIR_NAME: &str = "com.reddblock";

fn get_per_user_data_path(app: &AppHandle) -> PathBuf {
    // `app_data_dir()` fails only when the platform dirs are unresolvable.
    // Falling back keeps a broken environment on the same file the
    // handle-free resolver picks, instead of panicking the command.
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(DATA_FILE_NAME))
        .unwrap_or_else(|_| per_user_data_path_static())
}

/// Return the data file explicitly assigned to a local system-test process.
///
/// This override is intentionally feature-gated: a normal development or
/// production build must never be redirected by an ambient environment
/// variable. The runner supplies a path to an isolated temporary directory;
/// all data readers and writers use the same early-return hook below.
#[cfg(feature = "system-test")]
fn system_test_data_path() -> Option<PathBuf> {
    Some(
        std::env::var_os("REDD_BLOCK_SYSTEM_TEST_DATA_PATH")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            // Fail closed when somebody launches the test bundle outside the
            // runner: never fall through to production shared/per-user storage.
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join(format!(
                        "redd-block-system-test-unconfigured-{}",
                        std::process::id()
                    ))
                    .join("redd-block-data.json")
            }),
    )
}

#[cfg(feature = "system-test")]
fn should_import_legacy_data() -> bool {
    system_test_data_path().is_none()
}

/// Apply the system-test override to a normal resolver fallback. Keeping this
/// as one helper is important: handle-based and static callers must not drift
/// into separate environment-variable/path-selection behavior.
///
/// iOS resolves its paths through the App Group store instead and never calls
/// this, so gate it out there rather than carry a dead-code warning.
#[cfg(not(target_os = "ios"))]
fn apply_system_test_override(fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    #[cfg(feature = "system-test")]
    if let Some(path) = system_test_data_path() {
        return path;
    }

    fallback()
}

/// Machine-wide locations written by pre-3.x builds, newest first.
///
/// These are import *sources* only. Nothing writes to them any more: a
/// single file shared by every account on a PC meant one blocklist for
/// the whole family, edits that failed for whoever did not create the
/// file (`C:\ProgramData` grants Users create-folders, not create-files),
/// and every account able to read every other account's blocklist.
#[cfg(not(target_os = "ios"))]
fn legacy_shared_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut dirs = vec![crate::product_identity::windows_primary_shared_dir()];
        dirs.extend(crate::product_identity::windows_legacy_shared_dirs());
        dirs
    }
    #[cfg(not(target_os = "windows"))]
    {
        // The v1/v2 root helper's directory. Nothing has created it since
        // the helper was removed, so this only fires for v1.x upgraders.
        vec![PathBuf::from("/var/lib/redd-block")]
    }
}

/// Copy machine-wide data into this account's own store, taking the first
/// `shared_dirs` entry that has a data file. Returns whether it copied.
///
/// The destination wins only when it is *newer*. The pre-v3 per-user ->
/// shared migration copied without deleting, so an upgrading account can
/// hold a per-user file frozen at migration time beside the shared file it
/// has been editing ever since; preferring the local copy on age alone
/// would silently revert the user's blocklist — an enforcement gap, so the
/// tie is broken toward the file that was most recently written.
///
/// Never deletes the source: other accounts have not necessarily upgraded
/// yet, and each of them needs to import the same file.
#[cfg(not(target_os = "ios"))]
pub(crate) fn import_shared_data_into_per_user(
    dest: &std::path::Path,
    shared_dirs: &[PathBuf],
) -> bool {
    let modified = |path: &std::path::Path| {
        fs::metadata(path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH)
    };

    let Some(src) = shared_dirs
        .iter()
        .map(|dir| dir.join(DATA_FILE_NAME))
        .find(|candidate| candidate.is_file())
    else {
        return false;
    };

    if dest.exists() && modified(dest) >= modified(&src) {
        return false;
    }

    let contents = match fs::read(&src) {
        Ok(contents) => contents,
        Err(e) => {
            log::warn!("shared data import: failed to read {}: {e}", src.display());
            return false;
        }
    };

    match write_data_file_atomic(dest, &contents) {
        Ok(()) => {
            log::info!(
                "shared data import: copied {} -> {} (this account now has its own blocklist)",
                src.display(),
                dest.display()
            );
            true
        }
        Err(e) => {
            log::warn!(
                "shared data import: failed to copy {} -> {} atomically: {e}",
                src.display(),
                dest.display()
            );
            false
        }
    }
}

/// Run the import at most once per process, before the first read of the
/// per-user file. Every resolver goes through here rather than only
/// `load_data`, because the enforcement loops and `cross_app_consent` can
/// read the data file before the frontend ever asks for it.
#[cfg(not(target_os = "ios"))]
fn import_shared_data_once(dest: &std::path::Path) {
    use std::sync::Once;
    static IMPORTED: Once = Once::new();
    IMPORTED.call_once(|| {
        import_shared_data_into_per_user(dest, &legacy_shared_dirs());
    });
}

/// Resolve the canonical app-data path.
///
/// Always per-user, on every platform. macOS, Windows and iOS all treat
/// per-user application data as the native default, and nothing in the app
/// reads this file from another user's security context: the native host
/// is a child of the user's own browser, and the Windows watchdog task
/// registers unelevated as the invoking user.
///
/// Public accessor so other command modules can locate the canonical
/// redd-block-data.json without duplicating path selection logic.
pub fn canonical_data_path(app: &AppHandle) -> Option<PathBuf> {
    Some(get_data_path(app))
}

/// Same path selection as [`canonical_data_path`] but without an
/// [`AppHandle`]. Used by macOS startup gating (`cross_app_consent`)
/// before the frontend has loaded — must NOT scan legacy bundle-id
/// paths, only the canonical per-user location.
#[cfg(not(target_os = "ios"))]
pub fn canonical_data_path_static() -> PathBuf {
    apply_system_test_override(|| {
        let path = per_user_data_path_static();
        import_shared_data_once(&path);
        path
    })
}

#[cfg(not(target_os = "ios"))]
fn per_user_data_path_static() -> PathBuf {
    per_user_data_path_from(dirs::data_dir(), dirs::home_dir())
}

/// Split out from [`per_user_data_path_static`] so the no-`data_dir`
/// fallback is testable. That branch used to hand back a macOS
/// `~/Library/Application Support` path on Windows and Linux too.
#[cfg(not(target_os = "ios"))]
fn per_user_data_path_from(data_dir: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = data_dir {
        return dir.join(APP_DIR_NAME).join(DATA_FILE_NAME);
    }

    // Only reachable on a broken environment (no $HOME, no %APPDATA%).
    // Mirror each platform's own layout so the app and the native host
    // still agree on one file.
    #[cfg(target_os = "macos")]
    let relative = "Library/Application Support";
    #[cfg(target_os = "windows")]
    let relative = "AppData/Roaming";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let relative = ".local/share";

    home.unwrap_or_default()
        .join(relative)
        .join(APP_DIR_NAME)
        .join(DATA_FILE_NAME)
}

pub(crate) fn get_data_path(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "ios")]
    {
        return get_per_user_data_path(app);
    }

    #[cfg(not(target_os = "ios"))]
    {
        apply_system_test_override(|| {
            let path = get_per_user_data_path(app);
            import_shared_data_once(&path);
            path
        })
    }
}

/// Atomically replace the data file: write to a temp file in the same
/// directory, then rename over the destination.
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
        // No permission fixup: the file is per-user now, so the default
        // umask is what we want. The old 0666 made a user's blocklist
        // world-writable, which is exactly the sharing we removed.
        fs::rename(&tmp, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    } else {
        // Drop the shared parse cache so the enforcement loops re-read
        // this write even if it landed within the filesystem's
        // timestamp granularity (see data_cache.rs).
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        crate::data_cache::invalidate(path);
    }
    result
}

/// Ensure the parent directory for the data file exists.
fn ensure_data_dir(path: &std::path::Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create data directory {:?}: {}", parent, e))?;
    }
    Ok(())
}

/// Get the app version
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// True when this process is running from a Microsoft Store (MSIX) package.
/// Store users receive updates via the Store, not digitalhabits.org installers.
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
        if let Some(raw_accepted_at) = settings
            .extra
            .get("eulaAcceptedAt")
            .and_then(|value| value.as_u64())
        {
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
        // A system-test process starts from a deliberately empty isolated
        // store. Never import production or legacy per-user data into it:
        // doing so would both leak user state into tests and make a test
        // result depend on what happens to be installed on the host.
        #[cfg(feature = "system-test")]
        if !should_import_legacy_data() {
            return Ok(AppData::default());
        }

        // Migrate from per-user location or legacy paths
        if let Some(source_path) = find_per_user_data(&app) {
            if source_path == data_path {
                let content = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
                let mut data: AppData =
                    serde_json::from_str(&content).map_err(|e| e.to_string())?;
                if normalize_eula_state(&mut data) {
                    let migrated =
                        serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
                    write_data_file_atomic(&source_path, migrated.as_bytes())
                        .map_err(|e| e.to_string())?;
                }
                return Ok(data);
            }

            log::info!(
                "Migrating data into canonical per-user location: {:?} -> {:?}",
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
            data.settings
                .extra
                .insert((*key).to_string(), value.clone());
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
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
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
    // The normal implementation below deliberately enumerates shared,
    // current per-user, and legacy locations. In system-test mode that list
    // would be an unsafe production cleanup operation, so remove only the
    // exact isolated data file selected by the runner.
    #[cfg(feature = "system-test")]
    if system_test_data_path().is_some() {
        wipe_path(&get_data_path(app));
        return;
    }

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

    // Nothing writes these any more, but an uninstall still has to take
    // away the machine-wide copies a pre-3.x install left behind.
    for shared_dir in legacy_shared_dirs() {
        files.push(shared_dir.join(DATA_FILE_NAME));
        files.push(shared_dir.join("helper-state.json"));
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

#[cfg(test)]
mod shared_storage_import_tests;

#[cfg(all(test, feature = "system-test"))]
mod system_test_isolation_tests;
