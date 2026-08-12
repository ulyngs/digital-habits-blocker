//! Cross-app consent gating for macOS.
//!
//! Safari and Chromium website blocking uses **Automation** (Apple
//! Events) by default. **Safari extension mode** needs Full Disk Access
//! to read Safari's `Extensions.plist`. Firefox uses the ReDD Focus
//! extension with **manual** install — no FDA on that path.

#[cfg(target_os = "macos")]
use std::path::PathBuf;

#[cfg(target_os = "macos")]
fn has_accepted_eula_in_data() -> bool {
    let path = crate::commands::canonical_data_path_static();
    if !path.exists() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let Some(settings) = json.get("settings") else {
        return false;
    };
    if settings
        .get("eulaAcceptedRevision")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|n| n.max(0) as u64)))
        .map(|n| n > 0)
        .unwrap_or(false)
    {
        return true;
    }
    settings
        .get("eulaAccepted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn has_accepted_eula_in_data() -> bool {
    true
}

/// True when we can read Firefox's profile metadata (optional signal for
/// diagnostics; not a consent gate).
#[cfg(target_os = "macos")]
pub fn firefox_profile_data_accessible() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let root = home.join("Library/Application Support/Firefox");
    root.is_dir() && std::fs::read(root.join("profiles.ini")).is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn firefox_profile_data_accessible() -> bool {
    true
}

/// macOS: never auto-install Firefox native-host manifests or policy.
#[cfg(target_os = "macos")]
pub fn should_run_firefox_cross_app_installs() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn should_run_firefox_cross_app_installs() -> bool {
    true
}

/// macOS: no silent cross-app installs (Firefox is manual).
#[cfg(target_os = "macos")]
pub fn should_run_cross_app_installs() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn should_run_cross_app_installs() -> bool {
    true
}

/// True when the in-process enforcer loop may run (EULA on macOS).
#[cfg(target_os = "macos")]
pub fn should_run_enforcer() -> bool {
    should_run_web_automation()
}

#[cfg(not(target_os = "macos"))]
pub fn should_run_enforcer() -> bool {
    true
}

/// True when the macOS website-automation watcher may run (EULA only).
#[cfg(target_os = "macos")]
pub fn should_run_web_automation() -> bool {
    if !has_accepted_eula_in_data() {
        log::info!("tcc-probe: deferring web automation — EULA not accepted in data file");
        return false;
    }
    true
}

#[cfg(not(target_os = "macos"))]
pub fn should_run_web_automation() -> bool {
    true
}

/// Whether profile scans may run for the setup banner and onboarding UI.
#[cfg(target_os = "macos")]
pub fn should_run_profile_scans() -> bool {
    has_accepted_eula_in_data()
}

#[cfg(not(target_os = "macos"))]
pub fn should_run_profile_scans() -> bool {
    true
}

// ---- Safari extension mode: Full Disk Access --------------------------------

#[cfg(target_os = "macos")]
fn safari_fda_marker_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    Some(base.join("com.reddblock").join("safari-fda-onboarded.v1"))
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SafariFdaChoice {
    Granted,
    Revoked,
}

#[cfg(target_os = "macos")]
impl SafariFdaChoice {
    fn as_str(self) -> &'static str {
        match self {
            SafariFdaChoice::Granted => "granted",
            SafariFdaChoice::Revoked => "revoked",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "granted" | "granted-already" => Some(SafariFdaChoice::Granted),
            "revoked" => Some(SafariFdaChoice::Revoked),
            _ => None,
        }
    }
}

/// Live probe: can we read Safari's Web Extensions plist right now?
#[cfg(target_os = "macos")]
pub fn safari_extensions_plist_readable() -> bool {
    let Some(path) = crate::profile_scan::safari_extensions_plist_path() else {
        return false;
    };
    log::info!(
        "tcc-probe: about to read (Safari FDA probe) {}",
        path.display()
    );
    std::fs::read(&path).is_ok()
}

#[cfg(not(target_os = "macos"))]
pub fn safari_extensions_plist_readable() -> bool {
    true
}

#[cfg(target_os = "macos")]
pub fn safari_fda_choice() -> Option<SafariFdaChoice> {
    let path = safari_fda_marker_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    SafariFdaChoice::parse(&raw)
}

#[cfg(target_os = "macos")]
pub fn safari_fda_onboarding_choice_label() -> String {
    match safari_fda_choice() {
        Some(SafariFdaChoice::Granted) => "granted".to_string(),
        Some(SafariFdaChoice::Revoked) => "revoked".to_string(),
        None => String::new(),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn safari_fda_onboarding_choice_label() -> String {
    String::new()
}

#[cfg(target_os = "macos")]
pub fn mark_safari_fda_granted() {
    let Some(path) = safari_fda_marker_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, SafariFdaChoice::Granted.as_str().as_bytes());
}

#[cfg(target_os = "macos")]
pub fn user_chose_to_grant_safari_fda() -> bool {
    matches!(safari_fda_choice(), Some(SafariFdaChoice::Granted))
}

#[cfg(target_os = "macos")]
pub fn safari_fda_was_revoked() -> bool {
    matches!(safari_fda_choice(), Some(SafariFdaChoice::Revoked))
}

/// Marker says granted, or a live plist read succeeds (e.g. dev build
/// granted FDA to Terminal/Cursor instead of the packaged app).
#[cfg(target_os = "macos")]
pub fn safari_fda_effective() -> bool {
    user_chose_to_grant_safari_fda() || safari_extensions_plist_readable()
}

#[cfg(not(target_os = "macos"))]
pub fn safari_fda_effective() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn user_chose_to_grant_safari_fda() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn safari_fda_was_revoked() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn clear_fda_marker_on_safari_plist_denied() {
    if !user_chose_to_grant_safari_fda() {
        return;
    }
    log::warn!("safari-fda: extension plist PermissionDenied — marking FDA revoked");
    let Some(path) = safari_fda_marker_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, SafariFdaChoice::Revoked.as_str().as_bytes());
}

#[cfg(target_os = "macos")]
fn reconcile_stale_safari_fda_marker_if_needed() {
    if !user_chose_to_grant_safari_fda() {
        return;
    }
    if safari_extensions_plist_readable() {
        return;
    }
    log::warn!("safari-fda: marker granted but plist unreadable — marking revoked");
    let Some(path) = safari_fda_marker_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, SafariFdaChoice::Revoked.as_str().as_bytes());
}

/// User-facing FDA onboarding screen: reconcile marker, then probe plist.
#[cfg(target_os = "macos")]
pub fn sync_safari_fda_access() -> bool {
    reconcile_stale_safari_fda_marker_if_needed();
    safari_extensions_plist_readable()
}

#[cfg(not(target_os = "macos"))]
pub fn sync_safari_fda_access() -> bool {
    true
}
