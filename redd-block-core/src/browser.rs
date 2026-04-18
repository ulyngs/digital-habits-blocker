//! Browser identity metadata + on-disk extension probing.
//!
//! Two flavours of probe, both of which read preference files under the
//! user's home directory:
//!
//! - [`probe_chromium`] — reads `Local State` to enumerate profiles and
//!   merges `Preferences` + `Secure Preferences` to learn whether the
//!   ReDD Focus extension is installed / enabled / allowed in incognito.
//! - [`probe_firefox`] — reads `profiles.ini` and then each profile's
//!   `extensions.json` + `extension-preferences.json`.
//!
//! Both functions take an explicit `home: &Path` so they can be driven
//! from the Tauri app (user context → `dirs::home_dir()`) and the helper
//! daemon (root → [`crate::user::effective_user_home`]).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{chromium_root, firefox_root};

/// Browsers for which the Tauri app generates per-browser native-host
/// shim scripts. Keep in lockstep with [`browser_table`] on the
/// enforcement side.
pub const SHIM_BROWSERS: &[&str] = &["Chrome", "Brave", "Edge", "Firefox"];

/// Native messaging host name — must match the extension's
/// `connectNative(...)` call.
pub const NATIVE_HOST_NAME: &str = "com.ulriklyngs.mindshield";

/// Chromium extension IDs allowed to talk to our native host. The
/// published Web Store ID is the primary; additional IDs (unpacked dev
/// installs) can be appended via the `EXTRA_CHROMIUM_IDS` environment
/// variable.
pub const DEFAULT_CHROMIUM_IDS: &[&str] = &["hhblkhfdjijdinijakbmcpkmdfhoadcd"];

/// Firefox extension IDs accepted by the native host manifest.
pub const DEFAULT_FIREFOX_IDS: &[&str] = &["mindshield@example.com"];

/// Per-browser identity used by the enforcement loop when it needs to
/// name the browser to the user or to the OS (e.g. `pgrep -x
/// "Google Chrome"`, or `taskkill /IM chrome.exe`).
#[derive(Clone, Debug)]
pub struct BrowserMeta {
    /// Short label used everywhere internally ("Chrome", "Brave", …).
    /// Must match [`SHIM_BROWSERS`] entries and the `label` column of
    /// [`probe_chromium`] / [`probe_firefox`].
    pub label: &'static str,
    /// Human-readable application name used in nag copy.
    pub app_name: &'static str,
    /// Browser's own term for private browsing ("Incognito", "InPrivate",
    /// "Private Windows"). Used to compose alert copy.
    pub private_mode_name: &'static str,
    /// Executable names as the OS reports them. More than one may be
    /// present because Brave's executable is `Brave-Browser` on some
    /// platforms, for instance.
    pub proc_names: &'static [&'static str],
}

/// Static browser table. Kept in sync with [`SHIM_BROWSERS`].
pub fn browser_table() -> Vec<BrowserMeta> {
    vec![
        BrowserMeta {
            label: "Chrome",
            app_name: "Google Chrome",
            private_mode_name: "Incognito mode",
            #[cfg(target_os = "windows")]
            proc_names: &["chrome.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["Google Chrome"],
        },
        BrowserMeta {
            label: "Brave",
            app_name: "Brave",
            private_mode_name: "Private mode",
            #[cfg(target_os = "windows")]
            proc_names: &["brave.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["Brave Browser"],
        },
        BrowserMeta {
            label: "Edge",
            app_name: "Microsoft Edge",
            private_mode_name: "InPrivate mode",
            #[cfg(target_os = "windows")]
            proc_names: &["msedge.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["Microsoft Edge"],
        },
        BrowserMeta {
            label: "Firefox",
            app_name: "Firefox",
            private_mode_name: "Private Windows",
            #[cfg(target_os = "windows")]
            proc_names: &["firefox.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["firefox"],
        },
    ]
}

// ---------- Status shapes --------------------------------------------------

/// Aggregate extension-installation status for one browser. Returned
/// from [`probe_chromium`] / [`probe_firefox`] and consumed by both the
/// diagnostics panel and the enforcement loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub browser: String,
    /// True if the manifest file (mac) or registry key (Windows) we
    /// installed is still in place.
    pub manifest_installed: bool,
    /// True if the browser's root directory exists on disk at all — i.e.
    /// the user actually uses this browser.
    pub browser_installed: bool,
    /// Windows-only: whether our force-install policy entry is present
    /// under the browser's policy tree. `None` on platforms / labels
    /// where this isn't applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force_install_applied: Option<bool>,
    /// Per-profile extension info, lifted from on-disk prefs without
    /// talking to the extension.
    pub profiles: Vec<ProfileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Per-profile status within a browser. One profile pair per Chromium
/// profile, or per Firefox profile found in `profiles.ini`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub name: String,
    pub is_default: bool,
    pub installed: bool,
    pub enabled: bool,
    /// `None` means we couldn't tell (e.g. Safari's sandboxed pref). The
    /// enforcement loop treats `None` as "not allowed in private mode"
    /// for safety.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_browsing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Top-level status report bundled over IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatusReport {
    pub browsers: Vec<BrowserStatus>,
    pub native_host_name: String,
    pub host_script_path: Option<String>,
}

// ---------- Chromium probe -------------------------------------------------

/// Probe a Chromium-family browser (Chrome / Brave / Edge) under `home`.
/// The `label` must be one of the strings accepted by
/// [`crate::paths::chromium_root`]; unknown labels return a `browser_installed
/// = false` stub.
pub fn probe_chromium(
    home: &Path,
    label: &str,
    manifest_installed: bool,
    force_install_applied: Option<bool>,
) -> BrowserStatus {
    let root = match chromium_root(home, label) {
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

    let ids = chromium_extension_ids(home);
    let mut profiles = Vec::new();
    for name in profile_names {
        let dir = root.join(&name);
        let is_default = Some(name.as_str()) == last_used.as_deref().or(Some("Default"));
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

// ---------- Firefox probe -------------------------------------------------

pub fn probe_firefox(
    home: &Path,
    manifest_installed: bool,
    force_install_applied: Option<bool>,
) -> BrowserStatus {
    let root = firefox_root(home);
    if !root.exists() {
        return BrowserStatus {
            browser: "Firefox".into(),
            manifest_installed,
            browser_installed: false,
            force_install_applied,
            profiles: Vec::new(),
            error: None,
        };
    }

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
                            let active =
                                addon.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                            let user_disabled = addon
                                .get("userDisabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let app_disabled = addon
                                .get("appDisabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
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

// ---------- Manifest presence probe ---------------------------------------

/// Best-effort probe for whether our native-messaging manifest is
/// installed for `label`. On macOS we stat the user-scope manifest dir;
/// on Windows we leave the check to the Tauri app (which has registry
/// helpers) and always return `false` here.
///
/// The Tauri app uses its own `is_manifest_installed` (defined next to
/// the installer) so this variant is mostly for the helper daemon,
/// which needs a quick yes/no per tick without pulling in the whole
/// installer.
pub fn is_manifest_installed(home: &Path, label: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        for (l, dir) in crate::paths::browser_host_dirs(home) {
            if l == label {
                return dir.join(format!("{}.json", NATIVE_HOST_NAME)).exists();
            }
        }
        false
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (home, label);
        // On Windows the manifest lives in HKCU and can't be probed from
        // here without a Windows crate — the Tauri app still does the
        // real check and reports it back via IPC.
        false
    }
}

fn chromium_extension_ids(home: &Path) -> Vec<String> {
    let mut ids: Vec<String> = DEFAULT_CHROMIUM_IDS.iter().map(|s| s.to_string()).collect();

    let mut push_unique = |ids: &mut Vec<String>, candidate: &str| {
        let c = candidate.trim();
        if c.is_empty() {
            return;
        }
        if !ids.iter().any(|existing| existing == c) {
            ids.push(c.to_string());
        }
    };

    // Process env var — works for callers that inherit the shell env
    // (the Tauri app in `npm run dev`, the native-messaging host
    // subprocess spawned from a Tauri-launched browser, etc.).
    if let Ok(extra) = std::env::var("EXTRA_CHROMIUM_IDS") {
        for id in extra.split(',') {
            push_unique(&mut ids, id);
        }
    }

    // Sidecar file — the only way for the helper daemon to see
    // dev-time unpacked extension IDs, because it runs as a
    // LaunchDaemon with no access to the developer's shell env.
    if let Some(file) = crate::paths::extra_chromium_ids_file(home) {
        if let Ok(content) = std::fs::read_to_string(&file) {
            for id in content.split(|c: char| c == ',' || c.is_whitespace()) {
                push_unique(&mut ids, id);
            }
        }
    }

    ids
}

fn firefox_extension_ids() -> Vec<String> {
    DEFAULT_FIREFOX_IDS.iter().map(|s| s.to_string()).collect()
}

/// Utility: where would we expect to find the native-messaging manifest
/// for `label` under `home`? `None` on platforms / labels where we
/// don't install one.
#[cfg(target_os = "macos")]
pub fn mac_manifest_path(home: &Path, label: &str) -> Option<PathBuf> {
    for (l, dir) in crate::paths::browser_host_dirs(home) {
        if l == label {
            return Some(dir.join(format!("{}.json", NATIVE_HOST_NAME)));
        }
    }
    None
}
