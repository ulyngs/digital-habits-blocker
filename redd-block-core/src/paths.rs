//! Home-directory-scoped path helpers.
//!
//! Every helper in here takes the user's home directory as an explicit
//! argument so that the same code works from the Tauri app (which always
//! runs as the user) and from the privileged helper daemon (which runs as
//! root on macOS and needs to reach into the console user's home dir).
//!
//! See [`crate::user::effective_user_home`] for how to obtain that home
//! dir in caller code.

use std::path::{Path, PathBuf};

/// Per-user directory where ReDD Block drops its own artifacts:
/// - `com.ulriklyngs.mindshield-chrome.sh` (and the per-browser shims)
/// - `native-host-heartbeats/<Label>.stamp`
/// - The Windows-only per-browser manifest JSON files.
///
/// Given `home` (the console user's `$HOME`), this returns the platform
/// path we store everything under. Returns `None` on unsupported
/// platforms.
pub fn host_artifacts_dir(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Application Support/ReDD Block"))
    }
    #[cfg(target_os = "windows")]
    {
        // On Windows the Tauri app stores artifacts under the user's
        // `%LOCALAPPDATA%\ReDD Block` — which, for the logged-in user,
        // is exactly `<home>\AppData\Local\ReDD Block`.
        Some(home.join("AppData").join("Local").join("ReDD Block"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Some(home.join(".config/redd-block"))
    }
}

/// Per-user directory for native-host heartbeat stamp files.
pub fn heartbeat_dir(home: &Path) -> Option<PathBuf> {
    host_artifacts_dir(home).map(|d| d.join("native-host-heartbeats"))
}

/// Absolute path to the heartbeat stamp for a specific browser label
/// (one of `SHIM_BROWSERS`).
pub fn heartbeat_file(home: &Path, label: &str) -> Option<PathBuf> {
    heartbeat_dir(home).map(|d| d.join(format!("{label}.stamp")))
}

/// Sidecar file used to propagate the dev-time `EXTRA_CHROMIUM_IDS`
/// environment variable from the Tauri app (which sees it because
/// `npm run dev` sets it in the shell) to the helper daemon (which
/// doesn't — it's a LaunchDaemon started at login, with no access to
/// the developer's shell env).
///
/// The file is plain text: a comma- or whitespace-separated list of
/// extension IDs. The Tauri app writes it on startup; the helper reads
/// it every time it probes a Chromium browser. Missing file == no
/// extra IDs, which is the production case.
pub fn extra_chromium_ids_file(home: &Path) -> Option<PathBuf> {
    host_artifacts_dir(home).map(|d| d.join("extra-chromium-ids.txt"))
}

/// Chromium-family per-user profile root. `None` if the browser isn't
/// supported on this platform or the label isn't one of the known
/// Chromium family (`Chrome`, `Brave`, `Edge`).
pub fn chromium_root(home: &Path, label: &str) -> Option<PathBuf> {
    match label {
        #[cfg(target_os = "macos")]
        "Chrome" => Some(home.join("Library/Application Support/Google/Chrome")),
        #[cfg(target_os = "macos")]
        "Brave" => Some(home.join("Library/Application Support/BraveSoftware/Brave-Browser")),
        #[cfg(target_os = "macos")]
        "Edge" => Some(home.join("Library/Application Support/Microsoft Edge")),

        #[cfg(target_os = "windows")]
        "Chrome" => Some(
            home.join("AppData")
                .join("Local")
                .join("Google")
                .join("Chrome")
                .join("User Data"),
        ),
        #[cfg(target_os = "windows")]
        "Brave" => Some(
            home.join("AppData")
                .join("Local")
                .join("BraveSoftware")
                .join("Brave-Browser")
                .join("User Data"),
        ),
        #[cfg(target_os = "windows")]
        "Edge" => Some(
            home.join("AppData")
                .join("Local")
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

/// Firefox per-user root directory (`<home>/Library/Application
/// Support/Firefox`, `<home>/AppData/Roaming/Mozilla/Firefox`, or
/// `<home>/.mozilla/firefox`).
pub fn firefox_root(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        home.join("Library").join("Application Support").join("Firefox")
    }
    #[cfg(target_os = "windows")]
    {
        home.join("AppData").join("Roaming").join("Mozilla").join("Firefox")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        home.join(".mozilla").join("firefox")
    }
}

/// Per-browser native-messaging-host manifest install dirs (macOS /
/// Linux). Each browser has a user-scope location where we drop our
/// host manifest. Windows stores these in HKCU registry keys instead —
/// see `browser::windows_registry_targets` on the app side.
///
/// Returns pairs of `(label, dir)`.
#[cfg(target_os = "macos")]
pub fn browser_host_dirs(home: &Path) -> Vec<(&'static str, PathBuf)> {
    vec![
        (
            "Chrome",
            home.join("Library/Application Support/Google/Chrome/NativeMessagingHosts"),
        ),
        (
            "Brave",
            home.join(
                "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
            ),
        ),
        (
            "Edge",
            home.join("Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
        ),
        (
            "Firefox",
            home.join("Library/Application Support/Mozilla/NativeMessagingHosts"),
        ),
    ]
}

#[cfg(not(target_os = "macos"))]
pub fn browser_host_dirs(_home: &Path) -> Vec<(&'static str, PathBuf)> {
    Vec::new()
}
