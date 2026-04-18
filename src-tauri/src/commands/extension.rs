//! Browser extension bridge: install/uninstall the native-messaging-host
//! manifests and report status so the frontend can nag the user if the
//! extension path is broken.
//!
//! Two users of this module:
//!
//! 1. The Tauri app on startup / onboarding: calls `install_browser_extension_manifests`
//!    to drop the host manifest into every supported browser's user-scope
//!    `NativeMessagingHosts` location (no admin required on either OS).
//! 2. The frontend diagnostics panel: calls `check_extension_status` to learn
//!    whether the extension is installed + enabled across profiles, so we can
//!    surface an actionable error when blocking fails.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Browsers for which we generate per-browser native-host shims.
/// Each shim passes `--browser-label=<Label>` to the host so the host can
/// identify which browser spawned it (for heartbeat file naming, logs,
/// etc.). Keep in sync with `enforcer::browser_table`.
pub const SHIM_BROWSERS: &[&str] = &["Chrome", "Brave", "Edge", "Firefox"];

/// Native messaging host name — must match the extension's `connectNative()`
/// call in `reddfocus-open-source/Shared (Extension)/Resources/background.js`.
pub const NATIVE_HOST_NAME: &str = "com.ulriklyngs.mindshield";

/// Chromium extension IDs allowed to talk to our native host. The published
/// Web Store ID is the primary; additional IDs (unpacked dev installs) can be
/// appended via the `EXTRA_CHROMIUM_IDS` environment variable at install time.
const DEFAULT_CHROMIUM_IDS: &[&str] = &["hhblkhfdjijdinijakbmcpkmdfhoadcd"];

/// Firefox extension IDs.
const DEFAULT_FIREFOX_IDS: &[&str] = &["mindshield@example.com"];

/// Outcome of one manifest-installation attempt per browser. Collected and
/// returned to the frontend so the user can tell which browsers are wired up.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub browser: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub success: bool,
    pub host_script_path: Option<String>,
    pub results: Vec<InstallResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn collected_chromium_ids() -> Vec<String> {
    let mut ids: Vec<String> = DEFAULT_CHROMIUM_IDS.iter().map(|s| s.to_string()).collect();
    if let Ok(extra) = std::env::var("EXTRA_CHROMIUM_IDS") {
        for id in extra.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            ids.push(id.to_string());
        }
    }
    ids
}

fn collected_firefox_ids() -> Vec<String> {
    DEFAULT_FIREFOX_IDS.iter().map(|s| s.to_string()).collect()
}

// ---------- Platform paths ---------------------------------------------------

/// Per-user directory where we drop our own artifacts (the shim launcher +
/// the Windows-side manifest JSON files).
fn host_artifacts_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        Some(home.join("Library").join("Application Support").join("ReDD Block"))
    }
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
        Some(PathBuf::from(local_app_data).join("ReDD Block"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn browser_host_dirs() -> Vec<(&'static str, PathBuf)> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let app_support = home.join("Library").join("Application Support");
    vec![
        ("Chrome", app_support.join("Google/Chrome/NativeMessagingHosts")),
        (
            "Brave",
            app_support.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"),
        ),
        ("Edge", app_support.join("Microsoft Edge/NativeMessagingHosts")),
        ("Firefox", app_support.join("Mozilla/NativeMessagingHosts")),
    ]
}

#[cfg(target_os = "windows")]
fn windows_registry_targets() -> Vec<(&'static str, &'static str)> {
    // (browser label, HKCU sub-key) — all user-scope so no admin needed.
    vec![
        ("Chrome", "Software\\Google\\Chrome\\NativeMessagingHosts"),
        ("Brave", "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts"),
        ("Edge", "Software\\Microsoft\\Edge\\NativeMessagingHosts"),
        ("Firefox", "Software\\Mozilla\\NativeMessagingHosts"),
    ]
}

// ---------- Shim / launcher --------------------------------------------------

/// Resolve the current Tauri executable. On macOS, this is
/// `ReDD Block.app/Contents/MacOS/redd-block`; on Windows, it's wherever the
/// NSIS installer placed `redd-block.exe` (e.g. `C:\Program Files\ReDD Block`).
fn tauri_binary_path() -> std::io::Result<PathBuf> {
    std::env::current_exe()
}

/// Platform-specific filename for the per-browser shim script.
fn shim_file_name(label: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        format!("redd-block-native-host-{label}.sh")
    }
    #[cfg(target_os = "windows")]
    {
        format!("redd-block-native-host-{label}.bat")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        format!("redd-block-native-host-{label}")
    }
}

/// Resolve the on-disk shim path for `label`, if this platform has an
/// artifacts dir.
pub fn shim_path_for(label: &str) -> Option<PathBuf> {
    host_artifacts_dir().map(|d| d.join(shim_file_name(label)))
}

/// Directory where native-host subprocesses write their per-browser
/// heartbeat files. The enforcer reads from here to detect extension
/// liveness much faster than by probing Chrome's on-disk Preferences
/// (Chrome's `ImportantFileWriter` has a ~10 s commit delay, whereas the
/// heartbeat's cadence is 1 s).
pub fn heartbeat_dir() -> Option<PathBuf> {
    host_artifacts_dir().map(|d| d.join("native-host-heartbeats"))
}

/// Path to the heartbeat stamp file for a given browser label (one of
/// `SHIM_BROWSERS`).
pub fn heartbeat_file(label: &str) -> Option<PathBuf> {
    heartbeat_dir().map(|d| d.join(format!("{label}.stamp")))
}

/// Write (or refresh) one tiny launcher per supported browser in our
/// user-scope artifact dir. Each shim execs the Tauri binary with
/// `--native-host --browser-label=<Label>` so the host can tag its
/// heartbeat file with the correct browser.
///
/// Doing it this way (rather than bundling a separate `redd-block-host`
/// binary) keeps the MVP to a single signed executable, matching the
/// README's "Option 2 is probably cleaner" recommendation.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn write_host_shims() -> Result<HashMap<String, PathBuf>, String> {
    Err("host shim unsupported on this platform".into())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn write_host_shims() -> Result<HashMap<String, PathBuf>, String> {
    let artifacts = host_artifacts_dir().ok_or_else(|| "No artifacts dir on this platform".to_string())?;
    fs::create_dir_all(&artifacts).map_err(|e| format!("create {:?}: {e}", artifacts))?;

    let binary = tauri_binary_path().map_err(|e| format!("current_exe: {e}"))?;
    let mut shims = HashMap::new();

    // Clean up the pre-heartbeat single-shim if it's still around. Harmless
    // if it isn't: we just want to make sure upgraded installs don't leave
    // an orphan that confuses diagnostics output.
    let _ = fs::remove_file(artifacts.join(LEGACY_SHIM_NAME));

    for label in SHIM_BROWSERS {
        let script_path = artifacts.join(shim_file_name(label));

        #[cfg(target_os = "macos")]
        {
            let script = format!(
                "#!/usr/bin/env bash\n\
                 # Auto-generated by ReDD Block. Do not edit by hand.\n\
                 exec \"{bin}\" --native-host --browser-label={label} \"$@\"\n",
                bin = binary.display(),
                label = label,
            );
            fs::write(&script_path, script).map_err(|e| format!("write {:?}: {e}", script_path))?;
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&script_path)
                .map_err(|e| format!("stat {:?}: {e}", script_path))?
                .permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&script_path, perms)
                .map_err(|e| format!("chmod {:?}: {e}", script_path))?;
        }

        #[cfg(target_os = "windows")]
        {
            // Use a batch file so the browser sees a stable .bat entry point.
            // The batch file forwards to the Tauri binary with
            // `--native-host --browser-label=<Label>`. Chrome native messaging
            // captures the stdio pipes, so we don't need output redirection.
            let script = format!(
                "@echo off\r\n\
                 rem Auto-generated by ReDD Block. Do not edit by hand.\r\n\
                 \"{bin}\" --native-host --browser-label={label} %*\r\n",
                bin = binary.display(),
                label = label,
            );
            fs::write(&script_path, script).map_err(|e| format!("write {:?}: {e}", script_path))?;
        }

        shims.insert((*label).to_string(), script_path);
    }
    Ok(shims)
}

/// Legacy single-shim filename we previously generated (before
/// per-browser shims were introduced). Removed on every install/uninstall
/// so upgraded installs don't leave a stray file behind.
#[cfg(target_os = "macos")]
const LEGACY_SHIM_NAME: &str = "redd-block-native-host.sh";
#[cfg(target_os = "windows")]
const LEGACY_SHIM_NAME: &str = "redd-block-native-host.bat";

// ---------- Manifest bodies --------------------------------------------------

fn chromium_manifest(host_path: &Path) -> String {
    let ids: Vec<String> = collected_chromium_ids();
    let origins: Vec<String> = ids.iter().map(|id| format!("chrome-extension://{id}/")).collect();
    serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "ReDD Block native host",
        "path": host_path.display().to_string(),
        "type": "stdio",
        "allowed_origins": origins,
    })
    .to_string()
}

fn firefox_manifest(host_path: &Path) -> String {
    let ids = collected_firefox_ids();
    serde_json::json!({
        "name": NATIVE_HOST_NAME,
        "description": "ReDD Block native host",
        "path": host_path.display().to_string(),
        "type": "stdio",
        "allowed_extensions": ids,
    })
    .to_string()
}

// ---------- Install / uninstall ---------------------------------------------

/// Install manifests for every supported browser. Idempotent: overwrites
/// existing entries that match `NATIVE_HOST_NAME`, leaves every other host
/// manifest alone.
#[tauri::command]
pub async fn install_browser_extension_manifests() -> InstallReport {
    log::info!("install_browser_extension_manifests called");
    let shims = match write_host_shims() {
        Ok(p) => p,
        Err(e) => {
            return InstallReport {
                success: false,
                host_script_path: None,
                results: Vec::new(),
                error: Some(e),
            };
        }
    };

    // Best-effort: make sure the heartbeats dir exists. Native-host
    // subprocesses create it on demand too, but creating it here as well
    // means the enforcer's "heartbeat dir missing" path is a genuine
    // anomaly rather than an expected first-run state.
    if let Some(hb) = heartbeat_dir() {
        let _ = fs::create_dir_all(&hb);
    }

    let mut results = Vec::new();

    #[cfg(target_os = "macos")]
    {
        for (label, dir) in browser_host_dirs() {
            let shim = shims.get(label).cloned();
            let res = match shim {
                Some(p) => install_manifest_mac(&dir, label, &p),
                None => InstallResult {
                    browser: label.to_string(),
                    success: false,
                    manifest_path: None,
                    error: Some(format!("no shim for {label}")),
                },
            };
            results.push(res);
        }
    }

    #[cfg(target_os = "windows")]
    {
        for (label, key) in windows_registry_targets() {
            let shim = shims.get(label).cloned();
            let res = match shim {
                Some(p) => install_manifest_windows(label, key, &p),
                None => InstallResult {
                    browser: label.to_string(),
                    success: false,
                    manifest_path: None,
                    error: Some(format!("no shim for {label}")),
                },
            };
            results.push(res);
        }
    }

    // Representative path for diagnostics UI — users only ever see one
    // line, so we point at the Chrome shim (or whichever is first in the
    // map if Chrome is missing, e.g. on future platforms).
    let representative = shims
        .get("Chrome")
        .cloned()
        .or_else(|| shims.values().next().cloned());
    let all_ok = results.iter().all(|r| r.success);
    InstallReport {
        success: all_ok,
        host_script_path: representative.map(|p| p.display().to_string()),
        results,
        error: None,
    }
}

#[cfg(target_os = "macos")]
fn install_manifest_mac(dir: &Path, label: &str, host_script: &Path) -> InstallResult {
    let body = if label == "Firefox" {
        firefox_manifest(host_script)
    } else {
        chromium_manifest(host_script)
    };
    if let Err(e) = fs::create_dir_all(dir) {
        return InstallResult {
            browser: label.to_string(),
            success: false,
            manifest_path: None,
            error: Some(format!("create {:?}: {e}", dir)),
        };
    }
    let path = dir.join(format!("{}.json", NATIVE_HOST_NAME));
    match fs::write(&path, body) {
        Ok(()) => InstallResult {
            browser: label.to_string(),
            success: true,
            manifest_path: Some(path.display().to_string()),
            error: None,
        },
        Err(e) => InstallResult {
            browser: label.to_string(),
            success: false,
            manifest_path: Some(path.display().to_string()),
            error: Some(format!("write failed: {e}")),
        },
    }
}

#[cfg(target_os = "windows")]
fn install_manifest_windows(label: &str, key_path: &str, host_script: &Path) -> InstallResult {
    // Windows native messaging manifests live on disk (we write them under
    // `%LOCALAPPDATA%\ReDD Block\manifests\<browser>\`) and are pointed at by
    // an HKCU registry key. Both sides are user-scope.
    let base = match host_artifacts_dir() {
        Some(b) => b,
        None => {
            return InstallResult {
                browser: label.to_string(),
                success: false,
                manifest_path: None,
                error: Some("no artifacts dir".into()),
            }
        }
    };
    let manifest_dir = base.join("manifests").join(label);
    if let Err(e) = fs::create_dir_all(&manifest_dir) {
        return InstallResult {
            browser: label.to_string(),
            success: false,
            manifest_path: None,
            error: Some(format!("create {:?}: {e}", manifest_dir)),
        };
    }
    let manifest_path = manifest_dir.join(format!("{}.json", NATIVE_HOST_NAME));
    let body = if label == "Firefox" {
        firefox_manifest(host_script)
    } else {
        chromium_manifest(host_script)
    };
    if let Err(e) = fs::write(&manifest_path, body) {
        return InstallResult {
            browser: label.to_string(),
            success: false,
            manifest_path: Some(manifest_path.display().to_string()),
            error: Some(format!("write manifest: {e}")),
        };
    }

    // Registry entry: HKCU\<key_path>\<host_name> (Default) = <manifest_path>.
    let full_key = format!("{}\\{}", key_path, NATIVE_HOST_NAME);
    if let Err(e) = windows_registry_set_default_string(&full_key, &manifest_path.to_string_lossy()) {
        return InstallResult {
            browser: label.to_string(),
            success: false,
            manifest_path: Some(manifest_path.display().to_string()),
            error: Some(format!("write registry: {e}")),
        };
    }

    InstallResult {
        browser: label.to_string(),
        success: true,
        manifest_path: Some(manifest_path.display().to_string()),
        error: None,
    }
}

/// Tiny HKCU wrapper: create the key if missing, then set its `(Default)`
/// value to the provided UTF-16 string. Avoids pulling in the `winreg` crate
/// just for one write.
#[cfg(target_os = "windows")]
fn windows_registry_set_default_string(subkey: &str, value: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let subkey_w = HSTRING::from(subkey);
    let mut h_key: HKEY = HKEY::default();
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut h_key,
            None,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyExW: {:?}", rc));
    }

    // Value bytes: UTF-16 LE including terminating null.
    let value_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(value_w.as_ptr() as *const u8, value_w.len() * 2)
    };
    let set_rc = unsafe {
        RegSetValueExW(h_key, PCWSTR::null(), 0, REG_SZ, Some(bytes))
    };
    unsafe { let _ = RegCloseKey(h_key); };
    if set_rc != ERROR_SUCCESS {
        return Err(format!("RegSetValueExW: {:?}", set_rc));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_registry_subkey_exists(subkey: &str) -> bool {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let subkey_w = HSTRING::from(subkey);
    let mut h_key: HKEY = HKEY::default();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            0,
            KEY_READ,
            &mut h_key,
        )
    };
    let ok = rc == ERROR_SUCCESS;
    if ok {
        unsafe { let _ = RegCloseKey(h_key); };
    }
    ok
}

#[cfg(target_os = "windows")]
fn windows_registry_delete_tree(subkey: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};

    let subkey_w = HSTRING::from(subkey);
    let rc = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(subkey_w.as_ptr())) };
    if rc == ERROR_SUCCESS || rc == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("RegDeleteTreeW: {:?}", rc))
    }
}

/// Remove every manifest we installed. Used on app uninstall and on user
/// request from the diagnostics pane. Never removes other vendors' manifests.
#[tauri::command]
pub async fn uninstall_browser_extension_manifests() -> InstallReport {
    log::info!("uninstall_browser_extension_manifests called");
    let mut results = Vec::new();

    #[cfg(target_os = "macos")]
    {
        for (label, dir) in browser_host_dirs() {
            let path = dir.join(format!("{}.json", NATIVE_HOST_NAME));
            let success = if path.exists() {
                fs::remove_file(&path).is_ok()
            } else {
                true
            };
            // If the NativeMessagingHosts dir exists and is now empty, clean
            // it up — but only if we emptied it. Never touch non-empty dirs.
            if dir.exists() {
                if let Ok(entries) = fs::read_dir(&dir) {
                    if entries.count() == 0 {
                        let _ = fs::remove_dir(&dir);
                    }
                }
            }
            results.push(InstallResult {
                browser: label.to_string(),
                success,
                manifest_path: Some(path.display().to_string()),
                error: None,
            });
        }
    }

    #[cfg(target_os = "windows")]
    {
        for (label, key_path) in windows_registry_targets() {
            let full_key = format!("{}\\{}", key_path, NATIVE_HOST_NAME);
            match windows_registry_delete_tree(&full_key) {
                Ok(()) => results.push(InstallResult {
                    browser: label.to_string(),
                    success: true,
                    manifest_path: None,
                    error: None,
                }),
                Err(e) => results.push(InstallResult {
                    browser: label.to_string(),
                    success: false,
                    manifest_path: None,
                    error: Some(e),
                }),
            }
        }
        // Clean up the on-disk manifests dir we wrote.
        if let Some(base) = host_artifacts_dir() {
            let _ = fs::remove_dir_all(base.join("manifests"));
        }
    }

    // Remove every per-browser shim we may have installed (plus the
    // legacy single-shim name for upgraded installs) and clear the
    // heartbeats dir so an enforcer running afterwards doesn't look at
    // a stale stamp from a previous session.
    if let Some(base) = host_artifacts_dir() {
        for label in SHIM_BROWSERS {
            let _ = fs::remove_file(base.join(shim_file_name(label)));
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let _ = fs::remove_file(base.join(LEGACY_SHIM_NAME));
        let _ = fs::remove_dir_all(base.join("native-host-heartbeats"));
    }

    let all_ok = results.iter().all(|r| r.success);
    InstallReport {
        success: all_ok,
        host_script_path: None,
        results,
        error: None,
    }
}

// ---------- Force-install policies (Windows only) ---------------------------
//
// Force-install is the "hardening layer" from browser-ext-mvp/README.md: we
// drop the standard Chromium `ExtensionInstallForcelist` policy (and the
// Firefox `ExtensionSettings` equivalent) under `HKCU\Software\Policies\...`
// so the browser itself silently fetches ReDD Focus from the Web Store / AMO
// and locks it in place. No admin required (HKCU), no auto-updater infra
// required (ReDD Focus lives on the official stores).
//
// Caveats:
// - Chromium has no policy to auto-grant "Allow in Incognito". Users still
//   have to toggle that themselves; the enforcer loop covers the gap.
// - Firefox `force_installed` requires `install_url`; we point it at the
//   AMO "latest" redirect for ReDD Focus, and Firefox also auto-grants
//   private-window access because we set `private_browsing: true` in the
//   ExtensionSettings blob — so Firefox on Windows needs no user toggling.
// - All operations are HKCU-scoped and per-user; the helper daemon is not
//   involved and no elevation is required.

/// Chromium Web Store update endpoint. Brave and Edge honor this too for
/// Web-Store-hosted extensions.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const CHROMIUM_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";

/// AMO download URL for the Firefox build of ReDD Focus. Required by Firefox
/// for `installation_mode: "force_installed"`. If unset, the Firefox force-
/// install leg is skipped and the user falls back to manually installing
/// from AMO (the enforcer still nags them to enable it).
///
/// Uses the stable "latest" redirect so we never have to bump a version
/// string here when a new ReDD Focus build ships on AMO. Corresponds to
/// the public listing at <https://addons.mozilla.org/en-US/firefox/addon/reddfocus/>,
/// whose AMO `guid` is `mindshield@example.com` (matches `DEFAULT_FIREFOX_IDS`).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const FIREFOX_INSTALL_URL: Option<&str> =
    Some("https://addons.mozilla.org/firefox/downloads/latest/reddfocus/latest.xpi");

#[cfg(target_os = "windows")]
fn windows_chromium_forcelist_keys() -> Vec<(&'static str, &'static str)> {
    // Each value is the HKCU subkey *of the ExtensionInstallForcelist list*.
    // The policy schema is: values named "1", "2", ... each containing
    // "<extension_id>;<update_url>".
    vec![
        ("Chrome", "Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist"),
        ("Brave", "Software\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist"),
        ("Edge", "Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist"),
    ]
}

#[cfg(target_os = "windows")]
const WINDOWS_FIREFOX_POLICIES_KEY: &str = "Software\\Policies\\Mozilla\\Firefox";

/// Summary of a single force-install attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceInstallResult {
    pub browser: String,
    pub success: bool,
    pub applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForceInstallReport {
    pub supported: bool,
    pub success: bool,
    pub results: Vec<ForceInstallResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Install force-install policies for every Chromium-family browser plus
/// Firefox (when an AMO URL is configured). Idempotent: running this twice
/// does not create duplicate forcelist entries.
///
/// Returns a platform-accurate report on every OS. On non-Windows the
/// `supported` flag is false and the caller can show a platform-appropriate
/// nudge instead (macOS requires `sudo` for the managed-preferences path,
/// so we don't attempt it here — the enforcement loop fills that gap).
#[tauri::command]
pub async fn install_browser_extension_force_install_policies() -> ForceInstallReport {
    log::info!("install_browser_extension_force_install_policies called");

    #[cfg(target_os = "windows")]
    {
        let mut results = Vec::new();
        let chromium_id = collected_chromium_ids()
            .into_iter()
            .next()
            .unwrap_or_else(|| DEFAULT_CHROMIUM_IDS[0].to_string());

        for (label, key_path) in windows_chromium_forcelist_keys() {
            results.push(install_forcelist_chromium(label, key_path, &chromium_id));
        }

        results.push(install_forcelist_firefox());

        let all_ok = results.iter().all(|r| r.success);
        return ForceInstallReport {
            supported: true,
            success: all_ok,
            results,
            error: None,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        ForceInstallReport {
            supported: false,
            success: true,
            results: Vec::new(),
            error: Some(
                "Force-install via registry policy is Windows-only. macOS needs managed preferences (sudo); the enforcer loop covers that gap."
                    .into(),
            ),
        }
    }
}

/// Remove every force-install policy entry we installed. Leaves other
/// forcelist entries (e.g. ones the user's IT department added) alone.
#[tauri::command]
pub async fn uninstall_browser_extension_force_install_policies() -> ForceInstallReport {
    log::info!("uninstall_browser_extension_force_install_policies called");

    #[cfg(target_os = "windows")]
    {
        let mut results = Vec::new();
        let chromium_id = collected_chromium_ids()
            .into_iter()
            .next()
            .unwrap_or_else(|| DEFAULT_CHROMIUM_IDS[0].to_string());

        for (label, key_path) in windows_chromium_forcelist_keys() {
            results.push(uninstall_forcelist_chromium(label, key_path, &chromium_id));
        }

        results.push(uninstall_forcelist_firefox());

        let all_ok = results.iter().all(|r| r.success);
        return ForceInstallReport {
            supported: true,
            success: all_ok,
            results,
            error: None,
        };
    }

    #[cfg(not(target_os = "windows"))]
    {
        ForceInstallReport {
            supported: false,
            success: true,
            results: Vec::new(),
            error: None,
        }
    }
}

#[cfg(target_os = "windows")]
fn install_forcelist_chromium(label: &str, key_path: &str, extension_id: &str) -> ForceInstallResult {
    let entry = format!("{};{}", extension_id, CHROMIUM_UPDATE_URL);

    // Is there already a value anywhere under this key that contains our
    // extension id? If so, leave it alone (idempotent; respects any policy
    // another tool may have pre-populated).
    match windows_registry_find_value_starting_with(key_path, &format!("{};", extension_id)) {
        Ok(Some(name)) => {
            return ForceInstallResult {
                browser: label.into(),
                success: true,
                applied: false,
                registry_key: Some(format!("{}\\{}", key_path, name)),
                note: Some(format!("Existing entry '{}' already references extension.", name)),
                error: None,
            };
        }
        Err(e) => {
            // Can't enumerate → try to proceed anyway below.
            log::warn!("enumerate {}: {}", key_path, e);
        }
        Ok(None) => {}
    }

    // Pick the first free integer-named slot (1, 2, 3, ...). Chromium
    // accepts any value name; the integer convention is just to keep MMC
    // policy editors happy.
    let name = match windows_registry_first_free_integer_value_name(key_path) {
        Ok(n) => n,
        Err(e) => {
            return ForceInstallResult {
                browser: label.into(),
                success: false,
                applied: false,
                registry_key: Some(key_path.into()),
                note: None,
                error: Some(e),
            };
        }
    };

    if let Err(e) = windows_registry_set_named_string(key_path, &name, &entry) {
        return ForceInstallResult {
            browser: label.into(),
            success: false,
            applied: false,
            registry_key: Some(format!("{}\\{}", key_path, name)),
            note: None,
            error: Some(e),
        };
    }

    ForceInstallResult {
        browser: label.into(),
        success: true,
        applied: true,
        registry_key: Some(format!("{}\\{}", key_path, name)),
        note: None,
        error: None,
    }
}

#[cfg(target_os = "windows")]
fn uninstall_forcelist_chromium(label: &str, key_path: &str, extension_id: &str) -> ForceInstallResult {
    let needle = format!("{};", extension_id);
    let values = match windows_registry_list_string_values(key_path) {
        Ok(v) => v,
        Err(e) => {
            // Missing key is a clean no-op.
            if e.contains("ERROR_FILE_NOT_FOUND") {
                return ForceInstallResult {
                    browser: label.into(),
                    success: true,
                    applied: false,
                    registry_key: Some(key_path.into()),
                    note: Some("Policy key not present.".into()),
                    error: None,
                };
            }
            return ForceInstallResult {
                browser: label.into(),
                success: false,
                applied: false,
                registry_key: Some(key_path.into()),
                note: None,
                error: Some(e),
            };
        }
    };

    let mut removed = 0usize;
    let mut last_err: Option<String> = None;
    for (name, data) in &values {
        if data.starts_with(&needle) {
            match windows_registry_delete_named_value(key_path, name) {
                Ok(()) => removed += 1,
                Err(e) => last_err = Some(e),
            }
        }
    }

    ForceInstallResult {
        browser: label.into(),
        success: last_err.is_none(),
        applied: removed > 0,
        registry_key: Some(key_path.into()),
        note: (removed == 0 && last_err.is_none()).then(|| "No matching entry present.".to_string()),
        error: last_err,
    }
}

#[cfg(target_os = "windows")]
fn install_forcelist_firefox() -> ForceInstallResult {
    let ff_id = collected_firefox_ids()
        .into_iter()
        .next()
        .unwrap_or_else(|| DEFAULT_FIREFOX_IDS[0].to_string());

    let Some(install_url) = FIREFOX_INSTALL_URL else {
        return ForceInstallResult {
            browser: "Firefox".into(),
            success: true,
            applied: false,
            registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
            note: Some(
                "Firefox force-install requires an AMO install_url. None configured; skipping."
                    .into(),
            ),
            error: None,
        };
    };

    // Merge our entry into any existing ExtensionSettings JSON.
    let existing = windows_registry_read_named_string(
        WINDOWS_FIREFOX_POLICIES_KEY,
        "ExtensionSettings",
    )
    .unwrap_or_default();

    let mut root: serde_json::Value = serde_json::from_str(&existing).unwrap_or_else(|_| {
        serde_json::Value::Object(serde_json::Map::new())
    });
    if !root.is_object() {
        root = serde_json::Value::Object(serde_json::Map::new());
    }
    root.as_object_mut().unwrap().insert(
        ff_id.clone(),
        serde_json::json!({
            "installation_mode": "force_installed",
            "install_url": install_url,
            "private_browsing": true,
        }),
    );

    let serialized = match serde_json::to_string(&root) {
        Ok(s) => s,
        Err(e) => {
            return ForceInstallResult {
                browser: "Firefox".into(),
                success: false,
                applied: false,
                registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
                note: None,
                error: Some(format!("serialize ExtensionSettings: {e}")),
            };
        }
    };

    if let Err(e) = windows_registry_set_named_string(
        WINDOWS_FIREFOX_POLICIES_KEY,
        "ExtensionSettings",
        &serialized,
    ) {
        return ForceInstallResult {
            browser: "Firefox".into(),
            success: false,
            applied: false,
            registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
            note: None,
            error: Some(e),
        };
    }

    ForceInstallResult {
        browser: "Firefox".into(),
        success: true,
        applied: true,
        registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
        note: None,
        error: None,
    }
}

#[cfg(target_os = "windows")]
fn uninstall_forcelist_firefox() -> ForceInstallResult {
    let ff_id = collected_firefox_ids()
        .into_iter()
        .next()
        .unwrap_or_else(|| DEFAULT_FIREFOX_IDS[0].to_string());

    let existing = match windows_registry_read_named_string(
        WINDOWS_FIREFOX_POLICIES_KEY,
        "ExtensionSettings",
    ) {
        Ok(s) => s,
        Err(e) => {
            if e.contains("ERROR_FILE_NOT_FOUND") {
                return ForceInstallResult {
                    browser: "Firefox".into(),
                    success: true,
                    applied: false,
                    registry_key: Some(format!(
                        "{}\\ExtensionSettings",
                        WINDOWS_FIREFOX_POLICIES_KEY
                    )),
                    note: Some("Policy value not present.".into()),
                    error: None,
                };
            }
            return ForceInstallResult {
                browser: "Firefox".into(),
                success: false,
                applied: false,
                registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
                note: None,
                error: Some(e),
            };
        }
    };

    let mut root: serde_json::Value = match serde_json::from_str(&existing) {
        Ok(v) => v,
        Err(_) => {
            return ForceInstallResult {
                browser: "Firefox".into(),
                success: true,
                applied: false,
                registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
                note: Some("ExtensionSettings was not valid JSON; leaving untouched.".into()),
                error: None,
            };
        }
    };

    let had = root
        .as_object_mut()
        .map(|obj| obj.remove(&ff_id).is_some())
        .unwrap_or(false);

    if !had {
        return ForceInstallResult {
            browser: "Firefox".into(),
            success: true,
            applied: false,
            registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
            note: Some("No matching entry present.".into()),
            error: None,
        };
    }

    // If the object is now empty, just delete the value (cleaner for admins
    // inspecting the key) — otherwise write the pruned JSON back.
    let is_empty = root
        .as_object()
        .map(|o| o.is_empty())
        .unwrap_or(true);

    let write_res = if is_empty {
        windows_registry_delete_named_value(WINDOWS_FIREFOX_POLICIES_KEY, "ExtensionSettings")
    } else {
        match serde_json::to_string(&root) {
            Ok(s) => windows_registry_set_named_string(
                WINDOWS_FIREFOX_POLICIES_KEY,
                "ExtensionSettings",
                &s,
            ),
            Err(e) => Err(format!("serialize ExtensionSettings: {e}")),
        }
    };

    match write_res {
        Ok(()) => ForceInstallResult {
            browser: "Firefox".into(),
            success: true,
            applied: true,
            registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
            note: None,
            error: None,
        },
        Err(e) => ForceInstallResult {
            browser: "Firefox".into(),
            success: false,
            applied: false,
            registry_key: Some(format!("{}\\ExtensionSettings", WINDOWS_FIREFOX_POLICIES_KEY)),
            note: None,
            error: Some(e),
        },
    }
}

// ---------- Registry helpers for named-value policies -----------------------

#[cfg(target_os = "windows")]
fn windows_registry_set_named_string(subkey: &str, name: &str, value: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let subkey_w = HSTRING::from(subkey);
    let name_w = HSTRING::from(name);
    let mut h_key: HKEY = HKEY::default();
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut h_key,
            None,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyExW: {:?}", rc));
    }

    let value_w: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(value_w.as_ptr() as *const u8, value_w.len() * 2)
    };
    let set_rc = unsafe {
        RegSetValueExW(h_key, PCWSTR(name_w.as_ptr()), 0, REG_SZ, Some(bytes))
    };
    unsafe { let _ = RegCloseKey(h_key); };
    if set_rc != ERROR_SUCCESS {
        return Err(format!("RegSetValueExW: {:?}", set_rc));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_registry_read_named_string(subkey: &str, name: &str) -> Result<String, String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    let subkey_w = HSTRING::from(subkey);
    let name_w = HSTRING::from(name);
    let mut h_key: HKEY = HKEY::default();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            0,
            KEY_READ,
            &mut h_key,
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Err("ERROR_FILE_NOT_FOUND".into());
    }
    if rc != ERROR_SUCCESS {
        return Err(format!("RegOpenKeyExW: {:?}", rc));
    }

    // First call: ask how big the buffer needs to be.
    let mut size: u32 = 0;
    let probe = unsafe {
        RegQueryValueExW(h_key, PCWSTR(name_w.as_ptr()), None, None, None, Some(&mut size))
    };
    if probe == ERROR_FILE_NOT_FOUND {
        unsafe { let _ = RegCloseKey(h_key); };
        return Err("ERROR_FILE_NOT_FOUND".into());
    }
    if probe != ERROR_SUCCESS {
        unsafe { let _ = RegCloseKey(h_key); };
        return Err(format!("RegQueryValueExW(probe): {:?}", probe));
    }

    let mut buffer = vec![0u8; size as usize];
    let get = unsafe {
        RegQueryValueExW(
            h_key,
            PCWSTR(name_w.as_ptr()),
            None,
            None,
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    unsafe { let _ = RegCloseKey(h_key); };
    if get != ERROR_SUCCESS {
        return Err(format!("RegQueryValueExW: {:?}", get));
    }

    let byte_len = size as usize;
    if byte_len < 2 {
        return Ok(String::new());
    }
    // Drop trailing null(s).
    let u16_len = byte_len / 2;
    let slice = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr() as *const u16, u16_len)
    };
    let trimmed = match slice.iter().position(|&c| c == 0) {
        Some(idx) => &slice[..idx],
        None => slice,
    };
    Ok(String::from_utf16_lossy(trimmed))
}

#[cfg(target_os = "windows")]
fn windows_registry_delete_named_value(subkey: &str, name: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };

    let subkey_w = HSTRING::from(subkey);
    let name_w = HSTRING::from(name);
    let mut h_key: HKEY = HKEY::default();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            0,
            KEY_SET_VALUE,
            &mut h_key,
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    if rc != ERROR_SUCCESS {
        return Err(format!("RegOpenKeyExW: {:?}", rc));
    }
    let del = unsafe { RegDeleteValueW(h_key, PCWSTR(name_w.as_ptr())) };
    unsafe { let _ = RegCloseKey(h_key); };
    if del == ERROR_SUCCESS || del == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("RegDeleteValueW: {:?}", del))
    }
}

/// Enumerate every `REG_SZ` value under `subkey` and return `(name, data)`.
/// Missing keys surface as `ERROR_FILE_NOT_FOUND` so callers can treat that
/// as a clean no-op.
#[cfg(target_os = "windows")]
fn windows_registry_list_string_values(subkey: &str) -> Result<Vec<(String, String)>, String> {
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        REG_VALUE_TYPE,
    };

    let subkey_w = HSTRING::from(subkey);
    let mut h_key: HKEY = HKEY::default();
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey_w.as_ptr()),
            0,
            KEY_READ,
            &mut h_key,
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Err("ERROR_FILE_NOT_FOUND".into());
    }
    if rc != ERROR_SUCCESS {
        return Err(format!("RegOpenKeyExW: {:?}", rc));
    }

    let mut out: Vec<(String, String)> = Vec::new();
    let mut index: u32 = 0;

    loop {
        // Name buffer: MAX_VALUENAME is 16,383 UTF-16 chars per MSDN, but
        // realistic names are tiny. 512 is plenty for policy forcelist.
        let mut name_buf = vec![0u16; 512];
        let mut name_len: u32 = name_buf.len() as u32;
        let mut value_type = REG_VALUE_TYPE(0);
        let mut data_len: u32 = 0;

        let enum_rc = unsafe {
            RegEnumValueW(
                h_key,
                index,
                PWSTR(name_buf.as_mut_ptr()),
                &mut name_len,
                None,
                Some(&mut value_type.0),
                None,
                Some(&mut data_len),
            )
        };
        if enum_rc == ERROR_NO_MORE_ITEMS {
            break;
        }
        if enum_rc != ERROR_SUCCESS {
            unsafe { let _ = RegCloseKey(h_key); };
            return Err(format!("RegEnumValueW(probe): {:?}", enum_rc));
        }

        if value_type != REG_SZ {
            index += 1;
            continue;
        }

        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);

        // Second pass: pull the data. Re-pass the same name+index so the
        // kernel can locate the value.
        let mut data_buf = vec![0u8; data_len as usize];
        let mut name_len2: u32 = name_buf.len() as u32;
        let mut data_len2: u32 = data_buf.len() as u32;
        let mut value_type2 = REG_VALUE_TYPE(0);
        let get_rc = unsafe {
            RegEnumValueW(
                h_key,
                index,
                PWSTR(name_buf.as_mut_ptr()),
                &mut name_len2,
                None,
                Some(&mut value_type2.0),
                Some(data_buf.as_mut_ptr()),
                Some(&mut data_len2),
            )
        };
        if get_rc != ERROR_SUCCESS {
            unsafe { let _ = RegCloseKey(h_key); };
            return Err(format!("RegEnumValueW(read): {:?}", get_rc));
        }

        let byte_len = data_len2 as usize;
        let u16_len = byte_len / 2;
        let slice = unsafe {
            std::slice::from_raw_parts(data_buf.as_ptr() as *const u16, u16_len)
        };
        let trimmed = match slice.iter().position(|&c| c == 0) {
            Some(idx) => &slice[..idx],
            None => slice,
        };
        out.push((name, String::from_utf16_lossy(trimmed)));

        index += 1;
    }

    unsafe { let _ = RegCloseKey(h_key); };
    Ok(out)
}

#[cfg(target_os = "windows")]
fn windows_registry_find_value_starting_with(subkey: &str, prefix: &str) -> Result<Option<String>, String> {
    match windows_registry_list_string_values(subkey) {
        Ok(values) => Ok(values.into_iter().find(|(_, data)| data.starts_with(prefix)).map(|(n, _)| n)),
        Err(e) if e.contains("ERROR_FILE_NOT_FOUND") => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(target_os = "windows")]
fn windows_registry_first_free_integer_value_name(subkey: &str) -> Result<String, String> {
    let used: HashSet<String> = match windows_registry_list_string_values(subkey) {
        Ok(values) => values.into_iter().map(|(n, _)| n).collect(),
        Err(e) if e.contains("ERROR_FILE_NOT_FOUND") => HashSet::new(),
        Err(e) => return Err(e),
    };
    for n in 1u32..=10_000 {
        let cand = n.to_string();
        if !used.contains(&cand) {
            return Ok(cand);
        }
    }
    Err("forcelist slots exhausted".into())
}

// ---------- Status probing ---------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub browser: String,
    /// True if the manifest file (mac) or registry key (windows) we installed
    /// is still in place.
    pub manifest_installed: bool,
    /// True if the browser's root dir exists on disk at all.
    pub browser_installed: bool,
    /// Windows-only: whether our force-install policy entry is present under
    /// the browser's `ExtensionInstallForcelist` / `ExtensionSettings` policy
    /// tree. `None` on platforms where this isn't applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_install_applied: Option<bool>,
    /// Per-profile extension info, lifted from on-disk prefs without talking
    /// to the extension.
    pub profiles: Vec<ProfileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub name: String,
    pub is_default: bool,
    pub installed: bool,
    pub enabled: bool,
    /// May be `None` when we can't tell (e.g. Safari's sandboxed pref).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_browsing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatusReport {
    pub browsers: Vec<BrowserStatus>,
    pub native_host_name: String,
    pub host_script_path: Option<String>,
}

/// Quick status probe: is the manifest we installed still in place, and does
/// each browser profile have the extension installed + enabled + allowed in
/// private browsing? This is a Rust port of `browser-ext-mvp/profile-scan/scan.mjs`.
#[tauri::command]
pub async fn check_extension_status() -> ExtensionStatusReport {
    // Representative shim for diagnostics output. We point at Chrome's
    // because it's the most common; the actual install step writes one
    // shim per SHIM_BROWSERS entry.
    let host_script_path = shim_path_for("Chrome").map(|p| p.display().to_string());

    let mut browsers = Vec::new();
    browsers.push(probe_firefox());
    browsers.push(probe_chromium("Chrome"));
    browsers.push(probe_chromium("Brave"));
    browsers.push(probe_chromium("Edge"));

    ExtensionStatusReport {
        browsers,
        native_host_name: NATIVE_HOST_NAME.to_string(),
        host_script_path,
    }
}

fn chromium_extension_ids() -> Vec<String> {
    collected_chromium_ids()
}

fn firefox_extension_ids() -> Vec<String> {
    collected_firefox_ids()
}

// --- Firefox --------------------------------------------------------------

fn firefox_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(dirs::home_dir()?.join("Library").join("Application Support").join("Firefox"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        Some(PathBuf::from(appdata).join("Mozilla").join("Firefox"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Some(dirs::home_dir()?.join(".mozilla").join("firefox"))
    }
}

fn probe_firefox() -> BrowserStatus {
    let manifest_installed = is_manifest_installed("Firefox");
    let force_install_applied = is_force_install_applied("Firefox");
    let root = match firefox_root() {
        Some(r) if r.exists() => r,
        _ => {
            return BrowserStatus {
                browser: "Firefox".into(),
                manifest_installed,
                browser_installed: false,
                force_install_applied,
                profiles: Vec::new(),
                error: None,
            };
        }
    };

    let profiles_ini = root.join("profiles.ini");
    let mut profile_paths: Vec<String> = Vec::new();
    let mut default_paths: HashSet<String> = HashSet::new();

    if profiles_ini.exists() {
        if let Ok(content) = fs::read_to_string(&profiles_ini) {
            for block in content.split("\n[") {
                if block.trim_start().starts_with("Install") {
                    for line in block.lines() {
                        if let Some(rest) = line.strip_prefix("Default=") {
                            default_paths.insert(rest.trim().to_string());
                        }
                    }
                }
                for line in block.lines() {
                    if let Some(rest) = line.strip_prefix("Path=") {
                        profile_paths.push(rest.trim().to_string());
                    }
                }
            }
        }
    } else {
        let profiles_dir = root.join("Profiles");
        if let Ok(entries) = fs::read_dir(&profiles_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    profile_paths.push(format!("Profiles/{}", name));
                }
            }
        }
    }

    let ff_ids = firefox_extension_ids();
    let mut profiles = Vec::new();
    for rel in profile_paths {
        let dir = root.join(&rel);
        if !dir.is_dir() {
            continue;
        }
        let mut status = ProfileStatus {
            name: rel.clone(),
            is_default: default_paths.contains(&rel),
            installed: false,
            enabled: false,
            private_browsing: Some(false),
            note: None,
        };

        let ext_file = dir.join("extensions.json");
        if let Ok(text) = fs::read_to_string(&ext_file) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(addons) = value.get("addons").and_then(|a| a.as_array()) {
                    for addon in addons {
                        let id = addon.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        if ff_ids.iter().any(|needle| needle == id) {
                            status.installed = true;
                            let active = addon.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                            let user_disabled = addon.get("userDisabled").and_then(|v| v.as_bool()).unwrap_or(false);
                            let app_disabled = addon.get("appDisabled").and_then(|v| v.as_bool()).unwrap_or(false);
                            status.enabled = active && !user_disabled && !app_disabled;
                            break;
                        }
                    }
                }
            }
        }

        let prefs_file = dir.join("extension-preferences.json");
        if let Ok(text) = fs::read_to_string(&prefs_file) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                for ff_id in &ff_ids {
                    if let Some(entry) = value.get(ff_id) {
                        if let Some(perms) = entry.get("permissions").and_then(|p| p.as_array()) {
                            let pb = perms
                                .iter()
                                .any(|v| v.as_str() == Some("internal:privateBrowsingAllowed"));
                            status.private_browsing = Some(pb);
                        }
                    }
                }
            }
        }

        profiles.push(status);
    }

    BrowserStatus {
        browser: "Firefox".into(),
        manifest_installed,
        browser_installed: true,
        force_install_applied,
        profiles,
        error: None,
    }
}

// --- Chromium family ------------------------------------------------------

fn chromium_root(label: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    match label {
        #[cfg(target_os = "macos")]
        "Chrome" => Some(home.join("Library/Application Support/Google/Chrome")),
        #[cfg(target_os = "macos")]
        "Brave" => Some(home.join("Library/Application Support/BraveSoftware/Brave-Browser")),
        #[cfg(target_os = "macos")]
        "Edge" => Some(home.join("Library/Application Support/Microsoft Edge")),
        #[cfg(target_os = "windows")]
        "Chrome" => Some(
            PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
                .join("Google")
                .join("Chrome")
                .join("User Data"),
        ),
        #[cfg(target_os = "windows")]
        "Brave" => Some(
            PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("User Data"),
        ),
        #[cfg(target_os = "windows")]
        "Edge" => Some(
            PathBuf::from(std::env::var("LOCALAPPDATA").ok()?)
                .join("Microsoft")
                .join("Edge")
                .join("User Data"),
        ),
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        "Chrome" => Some(home.join(".config/google-chrome")),
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        "Brave" => Some(home.join(".config/BraveSoftware/Brave-Browser")),
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        "Edge" => Some(home.join(".config/microsoft-edge")),
        _ => None,
    }
}

fn probe_chromium(label: &str) -> BrowserStatus {
    let manifest_installed = is_manifest_installed(label);
    let force_install_applied = is_force_install_applied(label);
    let root = match chromium_root(label) {
        Some(r) if r.exists() => r,
        _ => {
            return BrowserStatus {
                browser: label.into(),
                manifest_installed,
                browser_installed: false,
                force_install_applied,
                profiles: Vec::new(),
                error: None,
            };
        }
    };

    let local_state = root.join("Local State");
    let mut profile_names: Vec<String> = Vec::new();
    let mut last_used: Option<String> = None;
    if local_state.exists() {
        if let Ok(text) = fs::read_to_string(&local_state) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(cache) = value
                    .get("profile")
                    .and_then(|p| p.get("info_cache"))
                    .and_then(|c| c.as_object())
                {
                    for k in cache.keys() {
                        profile_names.push(k.clone());
                    }
                }
                last_used = value
                    .get("profile")
                    .and_then(|p| p.get("last_used"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    if profile_names.is_empty() {
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if root.join(&name).join("Preferences").exists() {
                        profile_names.push(name);
                    }
                }
            }
        }
    }

    let ids = chromium_extension_ids();
    let mut profiles = Vec::new();
    for name in profile_names {
        let dir = root.join(&name);
        let is_default = Some(name.as_str())
            == last_used.as_deref().or(Some("Default"));
        let mut status = ProfileStatus {
            name: name.clone(),
            is_default,
            installed: false,
            enabled: false,
            private_browsing: Some(false),
            note: None,
        };

        let mut merged_settings = serde_json::Map::new();
        for file in ["Preferences", "Secure Preferences"] {
            let p = dir.join(file);
            if let Ok(text) = fs::read_to_string(&p) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(settings) = value
                        .get("extensions")
                        .and_then(|e| e.get("settings"))
                        .and_then(|s| s.as_object())
                    {
                        for (k, v) in settings {
                            merged_settings.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }

        for id in &ids {
            if let Some(entry) = merged_settings.get(id) {
                status.installed = true;
                let state = entry.get("state").and_then(|v| v.as_i64());
                let disable_reasons = entry.get("disable_reasons");
                let has_disable = match disable_reasons {
                    Some(serde_json::Value::Array(arr)) => !arr.is_empty(),
                    Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
                    _ => false,
                };
                status.enabled = state == Some(1) || (state.is_none() && !has_disable);
                status.private_browsing = Some(
                    entry
                        .get("incognito")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                );
                break;
            }
        }

        profiles.push(status);
    }

    BrowserStatus {
        browser: label.into(),
        manifest_installed,
        browser_installed: true,
        force_install_applied,
        profiles,
        error: None,
    }
}

// ---------- Manifest-installed probes ----------------------------------------

/// Is our force-install policy entry present for `label`? `None` on
/// platforms / labels where force-install isn't applicable.
fn is_force_install_applied(label: &str) -> Option<bool> {
    #[cfg(target_os = "windows")]
    {
        if label == "Firefox" {
            let existing = match windows_registry_read_named_string(
                WINDOWS_FIREFOX_POLICIES_KEY,
                "ExtensionSettings",
            ) {
                Ok(s) => s,
                Err(_) => return Some(false),
            };
            let Ok(root) = serde_json::from_str::<serde_json::Value>(&existing) else {
                return Some(false);
            };
            for id in collected_firefox_ids() {
                if root
                    .get(&id)
                    .and_then(|v| v.get("installation_mode"))
                    .and_then(|v| v.as_str())
                    == Some("force_installed")
                {
                    return Some(true);
                }
            }
            return Some(false);
        }
        for (l, key_path) in windows_chromium_forcelist_keys() {
            if l == label {
                let ids = collected_chromium_ids();
                for id in &ids {
                    let needle = format!("{};", id);
                    match windows_registry_find_value_starting_with(key_path, &needle) {
                        Ok(Some(_)) => return Some(true),
                        Ok(None) => continue,
                        Err(_) => continue,
                    }
                }
                return Some(false);
            }
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = label;
        None
    }
}

fn is_manifest_installed(label: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        for (l, dir) in browser_host_dirs() {
            if l == label {
                return dir.join(format!("{}.json", NATIVE_HOST_NAME)).exists();
            }
        }
        false
    }

    #[cfg(target_os = "windows")]
    {
        for (l, key_path) in windows_registry_targets() {
            if l == label {
                let full = format!("{}\\{}", key_path, NATIVE_HOST_NAME);
                return windows_registry_subkey_exists(&full);
            }
        }
        false
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = label;
        false
    }
}

// ---------- Native-host self-test --------------------------------------------

/// Snapshot the derivation path from the perspective of the native host,
/// without actually launching it. Useful for the diagnostics panel so the
/// user can see which domains *would* be pushed.
#[tauri::command]
pub async fn get_native_host_blocklist_preview() -> serde_json::Value {
    let (source, domains) = crate::blocklist::current_blocklist_with_source();
    serde_json::json!({
        "source": source.map(|p| p.display().to_string()),
        "blocklist": domains,
        "nativeHostName": NATIVE_HOST_NAME,
    })
}

// ---------- User-facing "fix it" actions ------------------------------------

/// Launch `browser` (one of Chrome/Brave/Edge/Firefox) and navigate it
/// directly to the extension management page for ReDD Focus. Used by the
/// in-app banner's "Re-enable ReDD Focus" button so the user can jump
/// straight to the relevant toggle instead of hunting through menus.
///
/// Chromium-family browsers accept `chrome-extension://<id>/` URLs, and
/// more helpfully `chrome://extensions/?id=<id>` with the deep-link
/// query — all three browsers honour the canonical `chrome://` scheme
/// (Brave / Edge silently rewrite it to their own scheme). Firefox
/// doesn't support a per-extension deep link, so we open `about:addons`
/// instead and let the user click the extension themselves.
///
/// We use `std::process::Command` directly (rather than the shell /
/// opener plugins) because those plugins require the specific URL to be
/// pre-declared in `tauri.conf.json`, and we want this to "just work"
/// without a round trip through the capability system.
#[tauri::command]
pub async fn open_browser_extensions_page(browser: String) -> Result<(), String> {
    // Pick the canonical extension ID for the deep-link query. For
    // Chromium we prefer the first entry, which is the Web Store ID in
    // production and whatever unpacked-dev ID the user configured via
    // EXTRA_CHROMIUM_IDS otherwise.
    let chromium_id = collected_chromium_ids()
        .into_iter()
        .next()
        .unwrap_or_default();

    let url = match browser.as_str() {
        "Firefox" => "about:addons".to_string(),
        _ if chromium_id.is_empty() => "chrome://extensions/".to_string(),
        _ => format!("chrome://extensions/?id={chromium_id}"),
    };

    #[cfg(target_os = "macos")]
    {
        let app_name = match browser.as_str() {
            "Brave" => "Brave Browser",
            "Edge" => "Microsoft Edge",
            "Firefox" => "Firefox",
            _ => "Google Chrome",
        };
        let out = std::process::Command::new("/usr/bin/open")
            .args(["-a", app_name, &url])
            .output()
            .map_err(|e| format!("spawn /usr/bin/open: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "`open -a {app_name}` exited with {}: {}",
                out.status,
                stderr.trim()
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows native browsers register themselves as handlers of
        // their own URL scheme, so `cmd /c start <browser.exe> <url>` is
        // the most reliable way to hit the right binary. Fall back to
        // `start <url>` (default browser) if the specific exe isn't on
        // PATH / registered.
        let exe = match browser.as_str() {
            "Brave" => Some("brave.exe"),
            "Edge" => Some("msedge.exe"),
            "Firefox" => Some("firefox.exe"),
            "Chrome" => Some("chrome.exe"),
            _ => None,
        };
        let args: Vec<String> = match exe {
            Some(b) => vec!["/c".into(), "start".into(), "".into(), b.into(), url.clone()],
            None => vec!["/c".into(), "start".into(), "".into(), url.clone()],
        };
        let out = std::process::Command::new("cmd")
            .args(&args)
            .output()
            .map_err(|e| format!("spawn cmd start: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "`cmd /c start` exited with {}: {}",
                out.status,
                stderr.trim()
            ));
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = url;
        let _ = browser;
        Err("open_browser_extensions_page unsupported on this platform".into())
    }
}

/// Bring the ReDD Block main window to the foreground. Called from the
/// frontend when the user clicks "Open ReDD Block" inside the OS
/// notification's follow-up in-app prompt, or after a deep-link callback.
/// Safe to call when the window is already visible — it's a no-op in that
/// case except for the `set_focus` side-effect.
#[tauri::command]
pub async fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    match app.get_webview_window("main") {
        Some(win) => {
            let _ = win.unminimize();
            let _ = win.show();
            win.set_focus().map_err(|e| format!("set_focus: {e}"))
        }
        None => Err("main window not found".into()),
    }
}
