//! System diagnostics — single command that returns a structured
//! snapshot of the app's runtime state. Replaces the v1.x-era
//! `get_helper_diagnostics` which only reported `{version, "extension"}`.
//!
//! Surface area kept *small*: things a user or support engineer
//! would actually want to see when the app is misbehaving. We
//! deliberately avoid putting tray-state, window-position, or
//! other internals in here — they're noise.

use serde::Serialize;

use crate::native_host;
use crate::profile_scan;

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub build_mode: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationInfo {
    /// Human-readable list of v1.x leftover items found on disk
    /// right now. Empty when fully clean.
    pub residue_items: Vec<String>,
    /// True if /etc/hosts.redd-backup (or Windows equivalent) exists,
    /// signalling this install ever ran v1.x. Kept around as a
    /// recovery copy by design — does NOT count as residue.
    pub came_from_v1x: bool,
    /// Last value the in-app migration stamped into settings.
    pub ran_at_version: Option<String>,
    /// Unix-millis of the last in-app migration completion. None
    /// when the .pkg preinstall did the cleanup (no in-app run).
    pub ran_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnforcerInfo {
    pub grace_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutostartInfo {
    pub enabled: bool,
}

/// macOS Automation (Apple Events) permission snapshot for Safari and
/// Chromium-family browsers. Inert on other platforms so the JSON shape
/// is stable.
#[derive(Debug, Clone, Serialize)]
pub struct AutomationBrowserInfo {
    pub label: String,
    /// `granted`, `denied`, or `unknown`
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AutomationInfo {
    pub applicable: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub browsers: Vec<AutomationBrowserInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg(target_os = "windows")]
pub struct WatchdogInfo {
    pub task_present: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg(target_os = "windows")]
pub struct NativeHostInfo {
    pub staged_exe_path: Option<String>,
    pub staged_exe_exists: bool,
    /// Last lines from `native-host.log` next to redd-block-data.json.
    pub log_tail: Vec<String>,
}

/// Snapshot of what's actually being enforced right now. The
/// `domains` / `blocks` fields are produced by reusing
/// `native_host::derive_payload` — i.e. literally the same function
/// that pushes the blocklist to the browser extension on every
/// frame. The `apps` list is read straight out of the in-process
/// app watcher's effective set. Both fields are derived data, never
/// recomputed from scratch in this module.
#[derive(Debug, Clone, Serialize)]
pub struct CurrentBlocking {
    /// Flat, deduped, lowercase domain list — what the extension
    /// receives in `{ "blocklist": [...] }`.
    pub domains: Vec<String>,
    /// Per-block breakdown: which blocklist contributed the domains,
    /// whether the source is an `activeBlock` (one-off) or a
    /// `schedule`, and the segment's start/end timestamps. Sorted
    /// ascending by `endsAt`.
    pub blocks: Vec<native_host::BlockInfo>,
    /// Effective blocked-app set the in-process watcher will kill on
    /// its next poll tick. Empty when no blocked apps are active or
    /// the watcher has not been started.
    pub apps: Vec<String>,
    /// Effective allowlist-mode allowed-app union (watcher snapshot or
    /// on-disk derivation when the watcher is not seeded yet).
    pub allowed_apps: Vec<String>,
    /// True when allowlist-mode app enforcement is active.
    pub allowlist_active: bool,
    /// Sorted union of allowed websites from active allowlist blocks.
    pub allowed_domains: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppDataInfo {
    /// Canonical path of redd-block-data.json (for display).
    pub path: Option<String>,
    /// File contents reformatted via serde_json so the user sees a
    /// pretty, deterministic view (helps eyeball schedules / active
    /// blocks / pause state). Falls back to the raw file content if
    /// the file is not parseable JSON, and is None if the file could
    /// not be read.
    pub pretty_json: Option<String>,
    /// Populated only when reading the file failed.
    pub error: Option<String>,
}

/// macOS Full Disk Access snapshot. On other platforms every field is
/// inert (`applicable = false`) so the diagnostics JSON shape is
/// stable across targets.
#[derive(Debug, Clone, Serialize)]
pub struct FdaInfo {
    pub applicable: bool,
    /// Live probe — can this process open the system TCC database?
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_granted: Option<bool>,
    /// Can Safari's Extensions.plist be read right now?
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safari_plist_readable: Option<bool>,
    /// Value stored in `fda-onboarded.v1`: `granted`, `revoked`, or
    /// empty when the marker is missing.
    pub onboarding_choice: String,
    /// From the latest Safari profile scan — true when the setup
    /// banner would show a grant-FDA action.
    #[serde(
        rename = "safariNeedsFdaAccess",
        skip_serializing_if = "Option::is_none"
    )]
    pub safari_needs_fda_access: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemDiagnostics {
    pub app: AppInfo,
    pub migration: MigrationInfo,
    pub fda: FdaInfo,
    pub browsers: profile_scan::ScanResult,
    pub enforcer: EnforcerInfo,
    pub autostart: AutostartInfo,
    pub automation: AutomationInfo,
    #[cfg(target_os = "windows")]
    pub watchdog: WatchdogInfo,
    #[cfg(target_os = "windows")]
    pub native_host: NativeHostInfo,
    /// Last N lines of the rolling app log, newest last. Empty in
    /// release builds (we only enable tauri-plugin-log in debug).
    pub recent_log: Vec<String>,
    /// What's *actually* being enforced at the time this struct is
    /// built — domains pushed to the browser extension and apps
    /// loaded into the watcher.
    pub current_blocking: CurrentBlocking,
    /// Snapshot of the on-disk app-data file. Surfaced so the user
    /// (or a support engineer) can sanity-check what blocklists,
    /// active blocks, schedules, and pause state are persisted right
    /// now without poking around in the filesystem.
    pub app_data: AppDataInfo,
}

#[tauri::command]
pub async fn get_system_diagnostics(app: tauri::AppHandle) -> SystemDiagnostics {
    // Build off the WebView thread. The collection path deliberately
    // avoids profile-tree walks, live TCC probes, and native-host
    // syncs — those can block forever behind a modal on macOS Sequoia.
    tauri::async_runtime::spawn_blocking(move || assemble_system_diagnostics(app))
        .await
        .unwrap_or_else(|_| assemble_system_diagnostics_minimal())
}

fn assemble_system_diagnostics(app: tauri::AppHandle) -> SystemDiagnostics {
    let app_info = AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        build_mode: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    };

    let migration = collect_migration_info(&app);
    let browsers = profile_scan::scan_for_diagnostics();
    let fda = collect_fda_info_for_diagnostics(&browsers);
    let enforcer = EnforcerInfo {
        grace_seconds: super::grace::get_extension_grace_seconds(app.clone()),
    };
    let autostart = AutostartInfo {
        enabled: autostart_enabled(&app),
    };
    let automation = collect_automation_info_cached(&app);

    #[cfg(target_os = "windows")]
    let watchdog = WatchdogInfo {
        task_present: crate::watchdog::is_registered(),
    };

    #[cfg(target_os = "windows")]
    let native_host = collect_native_host_info(&app);

    let recent_log = read_recent_log_lines(50);
    let current_blocking = collect_current_blocking(&app);
    let app_data = collect_app_data_info(&app);

    SystemDiagnostics {
        app: app_info,
        migration,
        fda,
        browsers,
        enforcer,
        autostart,
        automation,
        #[cfg(target_os = "windows")]
        watchdog,
        #[cfg(target_os = "windows")]
        native_host,
        recent_log,
        current_blocking,
        app_data,
    }
}

/// Fallback when the blocking worker panics — still returns a valid
/// shape so the frontend can render an error section.
fn assemble_system_diagnostics_minimal() -> SystemDiagnostics {
    SystemDiagnostics {
        app: AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            build_mode: if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            },
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
        },
        migration: MigrationInfo {
            residue_items: vec![],
            came_from_v1x: false,
            ran_at_version: None,
            ran_at_ms: None,
        },
        fda: FdaInfo {
            applicable: false,
            live_granted: None,
            safari_plist_readable: None,
            onboarding_choice: String::new(),
            safari_needs_fda_access: None,
        },
        browsers: profile_scan::scan_for_diagnostics(),
        enforcer: EnforcerInfo { grace_seconds: 0 },
        autostart: AutostartInfo { enabled: false },
        automation: AutomationInfo {
            applicable: false,
            browsers: vec![],
        },
        #[cfg(target_os = "windows")]
        watchdog: WatchdogInfo {
            task_present: false,
        },
        #[cfg(target_os = "windows")]
        native_host: NativeHostInfo {
            staged_exe_path: None,
            staged_exe_exists: false,
            log_tail: vec![],
        },
        recent_log: vec![],
        current_blocking: CurrentBlocking {
            domains: vec![],
            blocks: vec![],
            apps: vec![],
            allowed_apps: vec![],
            allowlist_active: false,
            allowed_domains: vec![],
        },
        app_data: AppDataInfo {
            path: None,
            pretty_json: None,
            error: Some("diagnostics worker failed".to_string()),
        },
    }
}

/// Build a snapshot of what's currently being enforced. Reuses
/// `native_host::derive_payload` for domains (single source of truth
/// for the extension push) and reads the in-memory app-watcher set
/// for apps — no re-derivation is done here.
fn collect_current_blocking(app: &tauri::AppHandle) -> CurrentBlocking {
    let (domains, blocks) = match super::canonical_data_path(app) {
        Some(p) => native_host::derive_payload(&p),
        None => (Vec::new(), Vec::new()),
    };
    let apps = collect_current_blocked_apps(app);
    let allowed_apps = collect_current_allowed_apps(app);
    let allowlist_active = collect_allowlist_active(app, &allowed_apps);
    let allowed_domains = allowed_domains_from_blocks(&blocks);
    CurrentBlocking {
        domains,
        blocks,
        apps,
        allowed_apps,
        allowlist_active,
        allowed_domains,
    }
}

/// Sorted union of `domains` from active allowlist-mode blocks.
fn allowed_domains_from_blocks(blocks: &[native_host::BlockInfo]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for b in blocks {
        if native_host::blocklist_mode_is_allowlist(&b.mode) {
            for d in &b.domains {
                set.insert(d.clone());
            }
        }
    }
    set.into_iter().collect()
}

fn collect_current_allowed_apps(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<super::app_blocking::AppWatcherState>();
    let from_watcher = match state.0.lock() {
        Ok(s) => s
            .as_ref()
            .map(|h| h.current_allowed_apps())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if !from_watcher.is_empty() {
        return from_watcher;
    }
    super::canonical_data_path(app)
        .map(|p| native_host::derive_allowed_apps(&p))
        .unwrap_or_default()
}

fn collect_allowlist_active(app: &tauri::AppHandle, disk_allowed_apps: &[String]) -> bool {
    use tauri::Manager;
    let state = app.state::<super::app_blocking::AppWatcherState>();
    if let Ok(s) = state.0.lock() {
        if let Some(h) = s.as_ref() {
            return h.is_allowlist_active();
        }
    }
    !disk_allowed_apps.is_empty()
}

/// Read the watcher's currently effective blocked-app set. Returns
/// empty when the watcher has not been started yet (no app blocks
/// have ever been activated this session).
fn collect_current_blocked_apps(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    let state = app.state::<super::app_blocking::AppWatcherState>();
    let from_watcher = match state.0.lock() {
        Ok(s) => s.as_ref().map(|h| h.current_apps()).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    if !from_watcher.is_empty() {
        return from_watcher;
    }
    // Watcher not seeded yet — show what the on-disk data says should
    // be active so app-only schedules aren't reported as empty.
    super::canonical_data_path(app)
        .map(|p| native_host::derive_blocked_apps(&p))
        .unwrap_or_default()
}

fn collect_app_data_info(app: &tauri::AppHandle) -> AppDataInfo {
    let path = super::canonical_data_path(app);
    let path_str = path.as_ref().map(|p| p.display().to_string());

    let p = match path {
        Some(p) => p,
        None => {
            return AppDataInfo {
                path: path_str,
                pretty_json: None,
                error: Some("canonical app-data path unavailable".to_string()),
            };
        }
    };

    let raw = match std::fs::read_to_string(&p) {
        Ok(s) => s,
        Err(e) => {
            return AppDataInfo {
                path: path_str,
                pretty_json: None,
                error: Some(format!("failed to read {}: {e}", p.display())),
            };
        }
    };

    let pretty = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .map(|mut v| {
            strip_diagnostics_only_execution_fields(&mut v);
            v
        })
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or(raw);

    AppDataInfo {
        path: path_str,
        pretty_json: Some(pretty),
        error: None,
    }
}

/// Keep diagnostics focused on persisted user intent. Runtime execution caches
/// used by backend enforcement stay in `current_blocking`, not the app-data view.
fn strip_diagnostics_only_execution_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.remove("resolvedSegments");
            for child in map.values_mut() {
                strip_diagnostics_only_execution_fields(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                strip_diagnostics_only_execution_fields(item);
            }
        }
        _ => {}
    }
}

/// FDA snapshot for diagnostics — marker only, no live plist read.
/// Reading Safari's protected Extensions.plist here can stall on TCC
/// while the modal is open.
// The macOS arm returns above; the trailing literal is the non-macOS value.
#[cfg_attr(target_os = "macos", allow(unreachable_code))]
fn collect_fda_info_for_diagnostics(browsers: &profile_scan::ScanResult) -> FdaInfo {
    #[cfg(target_os = "macos")]
    {
        let safari_ext = !crate::blocking_method::uses_automation_at_path(
            &crate::commands::canonical_data_path_static(),
            "safari",
        );
        let marker_granted = crate::cross_app_consent::user_chose_to_grant_safari_fda();
        let choice = crate::cross_app_consent::safari_fda_onboarding_choice_label();
        return FdaInfo {
            applicable: safari_ext,
            live_granted: if safari_ext {
                Some(marker_granted)
            } else {
                None
            },
            safari_plist_readable: None,
            onboarding_choice: if safari_ext { choice } else { String::new() },
            safari_needs_fda_access: if safari_ext {
                Some(browsers.safari.needs_fda_access)
            } else {
                None
            },
        };
    }
    #[cfg(not(target_os = "macos"))]
    let _ = browsers;
    FdaInfo {
        applicable: false,
        live_granted: None,
        safari_plist_readable: None,
        onboarding_choice: String::new(),
        safari_needs_fda_access: None,
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed_domains_from_blocks, strip_diagnostics_only_execution_fields};
    use crate::native_host::BlockInfo;
    use serde_json::json;

    #[test]
    fn allowed_domains_from_blocks_unions_allowlist_only() {
        let blocks = vec![
            BlockInfo {
                blocklist_id: "bl".to_string(),
                name: None,
                emoji: None,
                color: None,
                mode: "blocklist".to_string(),
                domains: vec!["blocked.com".to_string()],
                apps: vec![],
                source: "activeBlock",
                ends_at: Some(100),
                started_at: Some(0),
            },
            BlockInfo {
                blocklist_id: "al".to_string(),
                name: None,
                emoji: None,
                color: None,
                mode: "allowlist".to_string(),
                domains: vec![
                    "docs.example.com".to_string(),
                    "mail.example.com".to_string(),
                ],
                apps: vec![],
                source: "schedule",
                ends_at: Some(200),
                started_at: Some(0),
            },
            BlockInfo {
                blocklist_id: "al2".to_string(),
                name: None,
                emoji: None,
                color: None,
                mode: "allowlist".to_string(),
                domains: vec!["mail.example.com".to_string()],
                apps: vec![],
                source: "activeBlock",
                ends_at: Some(300),
                started_at: Some(0),
            },
        ];
        assert_eq!(
            allowed_domains_from_blocks(&blocks),
            vec![
                "docs.example.com".to_string(),
                "mail.example.com".to_string(),
            ]
        );
    }

    #[test]
    fn diagnostics_app_data_strips_resolved_segments_recursively() {
        let mut value = json!({
            "schedules": [{
                "id": "sch-1",
                "segments": [{ "days": [1] }],
                "resolvedSegments": [{
                    "activeFromTimestampMs": 100,
                    "activeUntilTimestampMs": 200
                }]
            }],
            "nested": {
                "resolvedSegments": [{
                    "activeFromTimestampMs": 300,
                    "activeUntilTimestampMs": 400
                }]
            }
        });

        strip_diagnostics_only_execution_fields(&mut value);

        assert!(value["schedules"][0].get("resolvedSegments").is_none());
        assert!(value["nested"].get("resolvedSegments").is_none());
        assert_eq!(value["schedules"][0]["segments"][0]["days"][0], 1);
    }
}

fn collect_migration_info(app: &tauri::AppHandle) -> MigrationInfo {
    let residue_items = current_residue_items();
    let came_from_v1x = super::migration::user_came_from_v1x();

    let settings_json = super::canonical_data_path(app)
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|j| j.get("settings").cloned());
    let ran_at_version = settings_json
        .as_ref()
        .and_then(|s| s.get("migrationRanAtVersion"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let ran_at_ms = settings_json
        .as_ref()
        .and_then(|s| s.get("migrationRanAt"))
        .and_then(|v| v.as_u64());

    MigrationInfo {
        residue_items,
        came_from_v1x,
        ran_at_version,
        ran_at_ms,
    }
}

/// Enumerate what v1.x leftovers are on disk RIGHT NOW. Returns a
/// list of human-readable item descriptions; empty when fully clean.
/// Mirrors the checks `migration::migration_pending_sync` makes but
/// reports specifics so the diagnostics UI can show the user exactly
/// what's still around.
fn current_residue_items() -> Vec<String> {
    let mut items = vec![];

    let hosts_path = if cfg!(target_os = "windows") {
        r"C:\Windows\System32\drivers\etc\hosts"
    } else {
        "/etc/hosts"
    };
    if let Ok(raw) = std::fs::read_to_string(hosts_path) {
        let has_markers = raw.lines().any(|l| {
            let t = l.trim();
            t == "# === BEGIN REDD BLOCK (reddfocus.org) ==="
                || t == "# === END REDD BLOCK (reddfocus.org) ==="
                || t == "# ReDD Block Start"
                || t == "# ReDD Block End"
        });
        if has_markers {
            items.push(format!("v1.x markers in {hosts_path}"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        for path in [
            "/Library/LaunchDaemons/com.redd.block.helper.plist",
            "/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist",
            "/Library/PrivilegedHelperTools/com.redd.block.helper",
            "/var/lib/redd-block/helper-state.json",
        ] {
            if std::path::Path::new(path).exists() {
                items.push(path.to_string());
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mut dirs = crate::product_identity::windows_legacy_shared_dirs();
        dirs.push(crate::product_identity::windows_primary_shared_dir());
        for dir in dirs {
            let p = dir.join("helper-state.json");
            if p.exists() {
                items.push(p.display().to_string());
            }
        }
    }

    items
}

fn autostart_enabled(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Automation snapshot for diagnostics — watcher cache only. Live TCC
/// queries and full process scans can contend with the automation tick
/// and stall the modal on "Loading…".
#[cfg(target_os = "macos")]
fn collect_automation_info_cached(app: &tauri::AppHandle) -> AutomationInfo {
    use tauri::Manager;

    use crate::commands::web_automation::WebAutomationState;
    use crate::web_automation::{self, SupportedBrowser};

    let cached = app.try_state::<WebAutomationState>().and_then(|state| {
        state
            .0
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|h| h.permission_status()))
    });

    let browsers = SupportedBrowser::all()
        .into_iter()
        .filter(|b| {
            let key = match b {
                SupportedBrowser::Safari => "safari",
                SupportedBrowser::Chrome => "chrome",
                SupportedBrowser::Brave => "brave",
                SupportedBrowser::Edge => "edge",
            };
            crate::blocking_method::uses_automation(app, key)
        })
        .map(|b| {
            let state = cached
                .as_ref()
                .and_then(|list| list.iter().find(|i| i.browser == b).map(|i| i.state))
                .unwrap_or(web_automation::PermState::Unknown);
            AutomationBrowserInfo {
                label: b.label().to_string(),
                state: match state {
                    web_automation::PermState::Granted => "granted",
                    web_automation::PermState::Denied => "denied",
                    web_automation::PermState::Unknown => "unknown",
                }
                .to_string(),
            }
        })
        .collect();

    AutomationInfo {
        applicable: true,
        browsers,
    }
}

#[cfg(not(target_os = "macos"))]
fn collect_automation_info_cached(_app: &tauri::AppHandle) -> AutomationInfo {
    AutomationInfo {
        applicable: false,
        browsers: vec![],
    }
}

/// Read up to `max_lines` lines from the back of the tauri-plugin-log
/// rolling file. Path conventions vary slightly per platform; we
/// query a few candidate dirs and take the newest .log file.
fn read_recent_log_lines(max_lines: usize) -> Vec<String> {
    let candidates = log_dir_candidates();
    let mut log_files: Vec<std::path::PathBuf> = candidates
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|rd| rd.flatten())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "log").unwrap_or(false))
        .collect();

    log_files.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::UNIX_EPOCH)
    });

    let newest = match log_files.last() {
        Some(p) => p.clone(),
        None => return Vec::new(),
    };

    let raw = match std::fs::read_to_string(&newest) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].iter().map(|s| s.to_string()).collect()
}

#[cfg(target_os = "windows")]
fn collect_native_host_info(app: &tauri::AppHandle) -> NativeHostInfo {
    let staged = crate::native_host_install::staged_native_host_exe();
    let staged_exe_path = staged.as_ref().map(|p| p.display().to_string());
    let staged_exe_exists = staged.is_some_and(|p| p.exists());
    let mut log_tail = Vec::new();
    if let Some(data) = super::canonical_data_path(app) {
        let mut log_path = data;
        log_path.pop();
        log_path.push("native-host.log");
        if let Ok(raw) = std::fs::read_to_string(&log_path) {
            let lines: Vec<&str> = raw.lines().collect();
            let start = lines.len().saturating_sub(30);
            log_tail = lines[start..].iter().map(|s| s.to_string()).collect();
        }
    }
    NativeHostInfo {
        staged_exe_path,
        staged_exe_exists,
        log_tail,
    }
}

fn log_dir_candidates() -> Vec<std::path::PathBuf> {
    let mut out = vec![];
    if let Some(home) = dirs::home_dir() {
        #[cfg(target_os = "macos")]
        out.push(home.join("Library/Logs/com.reddblock"));
        #[cfg(target_os = "windows")]
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(std::path::PathBuf::from(local).join(r"com.reddblock\logs"));
        }
        let _ = &home;
    }
    out
}
