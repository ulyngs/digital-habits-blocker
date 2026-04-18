//! Enforcement state, event shapes, and alert-copy builders.
//!
//! The enforcement *loop* itself lives in the helper daemon (so it
//! survives the Tauri app being quit); the types in here are the
//! language that loop speaks to the rest of the system.
//!
//! - [`FailureKind`] categorises why a browser is currently failing the
//!   extension probe.
//! - [`failure_kind_for`] + [`failure_message_body`] + [`action_button_label`]
//!   produce alert copy that matches the category.
//! - [`PerBrowserState`] + [`EnforcementSnapshot`] are the IPC payload
//!   the Tauri app pulls from the helper so it can render its in-app
//!   banner.
//! - [`EnforcementEvent`] is the delta-style event the helper fires into
//!   the Tauri app whenever something transitions (nag fired, countdown
//!   ticked, browser actually quit, etc).

use serde::{Deserialize, Serialize};

use crate::browser::{BrowserMeta, BrowserStatus, ProfileStatus};
use crate::heartbeat::HeartbeatStatus;

// ---------- Failure kinds + categorisation --------------------------------

/// Categorised reason a browser is currently failing the enforcement
/// check. Keeps the alert copy and the action button in lockstep: the
/// user-facing button text should always match the actual reason the
/// block isn't being enforced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureKind {
    /// Native host heartbeat is stale — the extension is almost
    /// certainly disabled / crashed.
    HeartbeatStale,
    /// Native-messaging manifest isn't on disk. Shouldn't happen unless
    /// the user deleted it manually.
    ManifestMissing,
    /// We couldn't read any profile — rare.
    NoProfile,
    /// Extension isn't installed in the user's default profile.
    ExtensionNotInstalled,
    /// Extension is installed but disabled.
    ExtensionDisabled,
    /// Extension is installed + enabled, but not permitted in private
    /// / incognito windows.
    PrivateBrowsingDisallowed,
    /// Catch-all for states we didn't specifically categorise.
    Unknown,
}

impl FailureKind {
    /// Human-readable short label, used for debug/log lines.
    pub fn as_str(&self) -> &'static str {
        match self {
            FailureKind::HeartbeatStale => "heartbeat-stale",
            FailureKind::ManifestMissing => "manifest-missing",
            FailureKind::NoProfile => "no-profile",
            FailureKind::ExtensionNotInstalled => "extension-not-installed",
            FailureKind::ExtensionDisabled => "extension-disabled",
            FailureKind::PrivateBrowsingDisallowed => "private-browsing-disallowed",
            FailureKind::Unknown => "unknown",
        }
    }
}

/// Collapse a heartbeat snapshot + the on-disk probe result into a
/// single [`FailureKind`]. If both signals agree we pick the more
/// specific reason; if the heartbeat is stale we short-circuit because
/// that's always the most accurate signal.
pub fn failure_kind_for(hb: HeartbeatStatus, status: Option<&BrowserStatus>) -> FailureKind {
    if matches!(hb, HeartbeatStatus::Stale(_)) {
        return FailureKind::HeartbeatStale;
    }
    let status = match status {
        Some(s) => s,
        None => return FailureKind::Unknown,
    };
    if !status.manifest_installed {
        return FailureKind::ManifestMissing;
    }
    let profile = status
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| status.profiles.first());
    let profile = match profile {
        Some(p) => p,
        None => return FailureKind::NoProfile,
    };
    if !profile.installed {
        return FailureKind::ExtensionNotInstalled;
    }
    if !profile.enabled {
        return FailureKind::ExtensionDisabled;
    }
    if profile.private_browsing != Some(true) {
        return FailureKind::PrivateBrowsingDisallowed;
    }
    FailureKind::Unknown
}

/// Copy for the primary action button on the nag alert. Describes
/// what clicking will *do* — all paths land the user on the ReDD Focus
/// detail page inside the browser's extension-management UI, where
/// every fix (enable, allow in private windows, re-install) is one
/// click away.
pub fn action_button_label(_kind: FailureKind, meta: &BrowserMeta) -> String {
    format!("Open ReDD Focus settings in {}", meta.app_name)
}

/// Body copy for the nag alert. Each kind names the concrete problem
/// and the concrete remedy. `reason` is the raw technical string from
/// the probe — only used as a fallback for the catch-all branch.
pub fn failure_message_body(kind: FailureKind, meta: &BrowserMeta, reason: &str) -> String {
    match kind {
        FailureKind::HeartbeatStale | FailureKind::ExtensionDisabled => format!(
            "ReDD Focus is turned off in {}, so your block isn't being enforced. \
             Turn it on now to keep your block active.",
            meta.app_name
        ),
        FailureKind::ExtensionNotInstalled => format!(
            "ReDD Focus isn't installed in {}, so your block isn't being enforced. \
             Install it now to keep your block active.",
            meta.app_name
        ),
        FailureKind::ManifestMissing => format!(
            "ReDD Block can't talk to ReDD Focus in {}. \
             Reinstall ReDD Focus to keep your block active.",
            meta.app_name
        ),
        FailureKind::PrivateBrowsingDisallowed => format!(
            "ReDD Focus isn't allowed in {mode} in {app}, so your block leaks through private tabs. \
             Enable it in {mode} now to keep your block active.",
            mode = meta.private_mode_name,
            app = meta.app_name,
        ),
        FailureKind::NoProfile | FailureKind::Unknown => format!(
            "ReDD Focus isn't enforcing your block in {} ({reason}). \
             Open the extension settings now to check what's wrong.",
            meta.app_name
        ),
    }
}

/// Short, technical "why" string for logs and the in-app banner footer.
/// Paired with [`failure_kind_for`] — the human-friendly copy in
/// [`failure_message_body`] uses this as a fallback for the catch-all
/// branches.
pub fn browser_failure_reason(status: Option<&BrowserStatus>) -> String {
    let status = match status {
        Some(s) => s,
        None => return "browser status unknown".into(),
    };
    if !status.manifest_installed {
        return "native-messaging manifest missing".into();
    }
    let profile = status
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| status.profiles.first());
    let profile = match profile {
        Some(p) => p,
        None => return "no profile found".into(),
    };
    if !profile.installed {
        return "extension not installed".into();
    }
    if !profile.enabled {
        return "extension disabled".into();
    }
    if profile.private_browsing != Some(true) {
        return "extension not allowed in private browsing".into();
    }
    "unknown reason".into()
}

// ---------- Pass/fail rules ----------------------------------------------

/// Check the on-disk probe is "clean" — extension installed + enabled
/// + allowed in private browsing, in the default profile.
pub fn profile_passes(p: &ProfileStatus) -> bool {
    if !p.installed || !p.enabled {
        return false;
    }
    matches!(p.private_browsing, Some(true))
}

/// Aggregate pass/fail for a whole browser. `true` also for
/// "browser-not-installed" cases (nothing to enforce).
pub fn browser_passes_check(status: Option<&BrowserStatus>) -> bool {
    let status = match status {
        Some(s) => s,
        None => return false,
    };
    if !status.browser_installed {
        return true;
    }
    if !status.manifest_installed {
        return false;
    }
    let profile = match status
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| status.profiles.first())
    {
        Some(p) => p,
        None => return false,
    };
    profile_passes(profile)
}

// ---------- IPC payload shapes --------------------------------------------

/// Per-browser snapshot the Tauri app polls from the helper to render
/// the in-app banner.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerBrowserState {
    pub browser: String,
    pub app_name: String,
    /// Is this browser currently failing the enforcement check?
    pub failing: bool,
    /// Categorised reason we're failing (only meaningful when
    /// `failing = true`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<FailureKind>,
    /// Technical reason string (for logs / footers).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// If we've entered a grace-period countdown for this browser, ms
    /// until we'll force-quit it. `None` means no active countdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<u64>,
}

/// Whole-system enforcement snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementSnapshot {
    /// `true` iff the helper is actively enforcing right now. `false`
    /// when no block is active (loop is dormant).
    pub active: bool,
    /// Current per-browser state, one entry for every browser we know
    /// about (even ones that are passing).
    pub browsers: Vec<PerBrowserState>,
}

/// Delta-style event the helper emits when something transitions.
/// Consumed by the Tauri app (which re-emits it to the frontend as
/// `extension-enforcement`) and by the helper's own alert-dispatch
/// thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementEvent {
    pub browser: String,
    /// One of `nag`, `cancelled`, `quit_attempted`, `quit_failed`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<FailureKind>,
}
