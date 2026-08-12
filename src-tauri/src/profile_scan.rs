// Rust port of the MVP profile-scanner prototype (see git history
// for browser-ext-mvp/profile-scan/scan.mjs).
//
// Detects whether the ReDD Focus browser extension is installed,
// enabled, and allowed in private/incognito mode across every user
// profile of Firefox / Chrome / Brave / Edge, plus Safari on macOS.
// Reads the browsers' on-disk preference files directly — no admin,
// no policy install, no native messaging required.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ReDD Focus extension IDs. Keep in sync with native_host_install.rs
// and BROWSER_STORE_LINKS in app.js.
const FIREFOX_ID: &str = "mindshield@example.com";
#[cfg(target_os = "macos")]
const SAFARI_EXTENSION_KEYS: &[&str] = &[
    // Legacy: Safari Web Extension embedded in older ReDD Blocker.app builds.
    "com.reddblock.SafariExtension (JD647S9RT6)",
    // Standalone "ReDD Focus" macOS app from the App Store. Still recognised
    // so users who installed it before we switched Safari to Automation
    // don't see a regression during duplicate-extension detection.
    "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
];
#[cfg(target_os = "macos")]
const SAFARI_BUNDLED_PLIST_KEY: &str = "com.reddblock.SafariExtension (JD647S9RT6)";
#[cfg(target_os = "macos")]
const SAFARI_STANDALONE_PLIST_KEY: &str = "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)";

/// Both the bundled (ReDD Blocker) and standalone (ReDD Focus app) Safari
/// Web Extensions are registered at once — Safari lists two "ReDD Focus"
/// rows and blocking/native-messaging can get confused.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SafariDuplicateExtensions {
    pub detected: bool,
}

/// Chromium IDs the scanner will accept as "ReDD Focus is here".
/// Delegates to `native_host_install::chromium_extension_ids` so
/// Edge Add-ons installs (different store ID) are recognised too.
fn chromium_ids() -> Vec<String> {
    crate::native_host_install::chromium_extension_ids()
}

#[cfg(target_os = "macos")]
fn safari_extension_keys() -> Vec<String> {
    let mut keys: Vec<String> = SAFARI_EXTENSION_KEYS
        .iter()
        .map(|key| (*key).to_string())
        .collect();
    if cfg!(debug_assertions) {
        if let Ok(extra) = std::env::var("REDD_DEV_SAFARI_EXTENSION_KEY") {
            for key in extra.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

/// Result for a single browser profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileStatus {
    pub name: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub installed: bool,
    /// `None` when we can't determine the state (e.g. Safari sandbox).
    pub enabled: Option<bool>,
    #[serde(rename = "privateBrowsing")]
    pub private_browsing: Option<bool>,
    #[serde(rename = "websiteAccessAll", skip_serializing_if = "Option::is_none")]
    pub website_access_all: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Result for a browser vendor across all profiles.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BrowserStatus {
    /// True when the browser process is currently running. Used by
    /// the enforcer's compliance check (no nag for browsers the user
    /// doesn't have open) and by the in-session compliance banner.
    pub present: bool,
    /// True when the browser appears to be installed on disk (profile
    /// directory or app bundle exists), regardless of whether it's
    /// running. Used by the migration onboarding screen so we can
    /// show install buttons for every browser the user has, not just
    /// the ones currently open.
    #[serde(default)]
    pub installed: bool,
    pub profiles: Vec<ProfileStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// macOS Safari only: both the bundled and standalone ReDD Focus
    /// extensions are registered. The onboarding UI asks the user to
    /// disable the standalone copy.
    #[serde(
        rename = "duplicateExtensions",
        skip_serializing_if = "Option::is_none"
    )]
    pub duplicate_extensions: Option<SafariDuplicateExtensions>,
    /// macOS Safari only: user previously granted Full Disk Access during
    /// onboarding but it was revoked in System Settings. Survives the
    /// FDA-free SafariServices scan path so the setup banner keeps nagging
    /// after app refocus / relaunch without re-reading the protected plist.
    #[serde(rename = "needsFdaAccess", default)]
    pub needs_fda_access: bool,
    /// macOS Firefox only: native-messaging manifest points at the
    /// current ReDD Blocker binary (extension blocking bridge).
    #[serde(rename = "nativeHostReady", default)]
    pub native_host_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub firefox: BrowserStatus,
    pub chrome: BrowserStatus,
    pub brave: BrowserStatus,
    pub edge: BrowserStatus,
    pub safari: BrowserStatus,
}

/// Scan every supported browser on the current platform.
pub fn scan() -> ScanResult {
    scan_filter(|_| true)
}

/// Lighter scan for onboarding UI and the setup banner.
///
/// On macOS, Safari + Chromium are blocked via Automation (see
/// `web_automation.rs`), so we only need install/running presence for
/// those — not a walk of their `Application Support` profile trees,
/// which triggers Sequoia per-app data-access TCC prompts and can
/// stall the UI when polled every few seconds. Firefox keeps the full
/// extension profile scan. Other platforms use the full scan.
pub fn scan_for_onboarding() -> ScanResult {
    #[cfg(target_os = "macos")]
    {
        if !crate::cross_app_consent::should_run_profile_scans() {
            log::info!("tcc-probe: profile_scan deferred — onboarding not complete");
            return empty_scan_result();
        }
        let path = crate::commands::canonical_data_path_static();
        let mut result = scan_filter(|label| match label {
            "firefox" => true,
            "safari" | "chrome" | "brave" | "edge" => {
                !crate::blocking_method::uses_automation_at_path(&path, label)
            }
            _ => false,
        });
        if crate::blocking_method::uses_automation_at_path(&path, "chrome") {
            result.chrome = ChromiumBrowser::Chrome.presence_only();
        }
        if crate::blocking_method::uses_automation_at_path(&path, "brave") {
            result.brave = ChromiumBrowser::Brave.presence_only();
        }
        if crate::blocking_method::uses_automation_at_path(&path, "edge") {
            result.edge = ChromiumBrowser::Edge.presence_only();
        }
        if crate::blocking_method::uses_automation_at_path(&path, "safari") {
            result.safari = safari_presence_only();
        }
        if result.firefox.installed {
            if let Err(e) = crate::native_host_install::sync_firefox_native_host(false) {
                log::warn!("native-host sync for firefox during onboarding scan failed: {e}");
            }
            result.firefox.native_host_ready =
                crate::native_host_install::firefox_native_host_is_current();
        }
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        scan()
    }
}

/// Browser snapshot for the diagnostics modal. On macOS, walk profile
/// trees only for browsers that actually use the ReDD Focus extension
/// (Firefox always; Chromium/Safari only when not on Automation).
/// Automation-mode browsers stay presence-only so opening diagnostics
/// does not trigger Sequoia data-access prompts for Chrome/Brave/Edge/
/// Safari the user is not using for extension blocking.
pub fn scan_for_diagnostics() -> ScanResult {
    #[cfg(target_os = "macos")]
    {
        if !crate::cross_app_consent::should_run_profile_scans() {
            log::info!("tcc-probe: profile_scan deferred — onboarding not complete");
            return empty_scan_result();
        }
        let path = crate::commands::canonical_data_path_static();
        let mut result = scan_filter(|label| match label {
            "firefox" => true,
            "safari" | "chrome" | "brave" | "edge" => {
                !crate::blocking_method::uses_automation_at_path(&path, label)
            }
            _ => false,
        });
        if crate::blocking_method::uses_automation_at_path(&path, "chrome") {
            result.chrome = ChromiumBrowser::Chrome.presence_only();
        }
        if crate::blocking_method::uses_automation_at_path(&path, "brave") {
            result.brave = ChromiumBrowser::Brave.presence_only();
        }
        if crate::blocking_method::uses_automation_at_path(&path, "edge") {
            result.edge = ChromiumBrowser::Edge.presence_only();
        }
        if crate::blocking_method::uses_automation_at_path(&path, "safari") {
            result.safari = safari_presence_only();
        }
        if result.firefox.installed {
            result.firefox.native_host_ready =
                crate::native_host_install::firefox_native_host_is_current();
        }
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        scan()
    }
}

#[allow(dead_code)] // used on macOS; dead on Windows
fn empty_scan_result() -> ScanResult {
    ScanResult {
        firefox: empty("firefox"),
        chrome: empty("chrome"),
        brave: empty("brave"),
        edge: empty("edge"),
        safari: empty("safari"),
    }
}

/// Scan only the browsers for which `should_scan` returns true; the
/// rest are returned as empty stubs (`installed=false, present=false,
/// profiles=[]`).
///
/// Why this exists: the underlying scan reads each browser's
/// `~/Library/Application Support/<vendor>/...` data files. On
/// macOS Sequoia 15+ that triggers a per-app "ReDD Blocker would like
/// to access data from other apps" TCC prompt for *each* browser
/// data folder we touch — so a user with Chrome + Brave + Edge +
/// Firefox installed gets four serial prompts on a single tick. The
/// enforcer only ever takes action on *running* browsers, so it
/// passes a predicate that filters to those, dropping prompts (and
/// I/O cost) for browsers that aren't currently open.
///
/// The vendor labels passed to the predicate are the lowercase
/// short names: "firefox", "chrome", "brave", "edge", "safari".
pub fn scan_filter<F: Fn(&str) -> bool>(should_scan: F) -> ScanResult {
    #[cfg(target_os = "macos")]
    if !crate::cross_app_consent::should_run_profile_scans() {
        log::info!("tcc-probe: profile_scan deferred — onboarding not complete");
        return empty_scan_result();
    }

    ScanResult {
        firefox: if should_scan("firefox") {
            with_native_host_ready(
                scan_firefox().unwrap_or_else(|| empty("firefox")),
                crate::native_host_install::BrowserTarget::Firefox,
            )
        } else {
            empty("firefox")
        },
        chrome: if should_scan("chrome") {
            with_native_host_ready(
                scan_chromium(ChromiumBrowser::Chrome).unwrap_or_else(|| empty("chrome")),
                crate::native_host_install::BrowserTarget::Chrome,
            )
        } else {
            empty("chrome")
        },
        brave: if should_scan("brave") {
            with_native_host_ready(
                scan_chromium(ChromiumBrowser::Brave).unwrap_or_else(|| empty("brave")),
                crate::native_host_install::BrowserTarget::Brave,
            )
        } else {
            empty("brave")
        },
        edge: if should_scan("edge") {
            with_native_host_ready(
                scan_chromium(ChromiumBrowser::Edge).unwrap_or_else(|| empty("edge")),
                crate::native_host_install::BrowserTarget::Edge,
            )
        } else {
            empty("edge")
        },
        safari: if should_scan("safari") {
            scan_safari()
        } else {
            empty("safari")
        },
    }
}

fn empty(_label: &str) -> BrowserStatus {
    BrowserStatus::default()
}

#[cfg(target_os = "windows")]
fn with_native_host_ready(
    mut status: BrowserStatus,
    browser: crate::native_host_install::BrowserTarget,
) -> BrowserStatus {
    status.native_host_ready = crate::native_host_install::native_host_is_current(browser);
    status
}

#[cfg(not(target_os = "windows"))]
fn with_native_host_ready(
    status: BrowserStatus,
    _browser: crate::native_host_install::BrowserTarget,
) -> BrowserStatus {
    status
}

fn firefox_root() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(dirs::home_dir()?.join("Library/Application Support/Firefox"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from)?;
        Some(appdata.join(r"Mozilla\Firefox"))
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Some(dirs::home_dir()?.join(".mozilla/firefox"))
    }
}

/// Bundle (or equivalent) on disk, regardless of running state.
pub fn firefox_app_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        let candidates = [
            PathBuf::from("/Applications/Firefox.app"),
            dirs::home_dir()
                .map(|h| h.join("Applications/Firefox.app"))
                .unwrap_or_default(),
        ];
        candidates.iter().any(|p| p.exists())
    }
    #[cfg(target_os = "windows")]
    {
        find_browser_exe("firefox").is_some()
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        firefox_root().map(|p| p.exists()).unwrap_or(false)
    }
}

/// Find the full path to a browser executable by name (e.g. "chrome",
/// "firefox", "brave", "edge"). Returns `None` if not found on disk.
/// Used by `open_browser_extension_settings` so we can launch browsers
/// directly instead of going through `cmd /c start`.
#[cfg(target_os = "windows")]
pub fn find_browser_exe(name: &str) -> Option<PathBuf> {
    let subpath = match name {
        "chrome" => r"Google\Chrome\Application\chrome.exe",
        "brave" => r"BraveSoftware\Brave-Browser\Application\brave.exe",
        "edge" => r"Microsoft\Edge\Application\msedge.exe",
        "firefox" => r"Mozilla Firefox\firefox.exe",
        _ => return None,
    };
    [
        std::env::var_os("ProgramFiles"),
        std::env::var_os("ProgramFiles(x86)"),
        std::env::var_os("LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    .map(|root| PathBuf::from(root).join(subpath))
    .find(|p| p.exists())
}

fn firefox_app_present() -> bool {
    #[cfg(target_os = "macos")]
    {
        is_process_running(&["firefox", "firefox-bin"])
    }
    #[cfg(target_os = "windows")]
    {
        is_process_running(&["firefox.exe"])
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        is_process_running(&["firefox", "firefox-esr"])
    }
}

/// True when an `extensions.json` addon row represents a real on-profile
/// install. Firefox often keeps catalog metadata after the user removes an
/// add-on (`pendingUninstall`, `visible: false`, or a stale `path`). Those
/// rows must not map to "installed but disabled" in the migration UI.
fn firefox_addon_counts_as_installed(addon: &Value, profile_dir: &Path) -> bool {
    if addon.get("pendingUninstall").and_then(|v| v.as_bool()) == Some(true) {
        return false;
    }
    if addon.get("visible").and_then(|v| v.as_bool()) == Some(false) {
        return false;
    }
    if let Some(path) = addon.get("path").and_then(|v| v.as_str()) {
        if path.is_empty() || !profile_dir.join(path).exists() {
            return false;
        }
    }
    true
}

fn firefox_addon_enabled(addon: &Value) -> bool {
    let active = addon
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let user_disabled = addon
        .get("userDisabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let app_disabled = addon
        .get("appDisabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    active && !user_disabled && !app_disabled
}

fn scan_firefox() -> Option<BrowserStatus> {
    let running = firefox_app_present();
    let installed = firefox_app_installed();
    let root = firefox_root()?;
    if !installed || !root.exists() {
        return Some(BrowserStatus {
            present: running,
            installed,
            profiles: vec![],
            error: None,
            duplicate_extensions: None,
            needs_fda_access: false,
            native_host_ready: false,
        });
    }

    let (profile_dirs, defaults) = read_firefox_profiles(&root);
    let mut profiles = vec![];
    for rel in profile_dirs {
        let dir = root.join(&rel);
        if !dir.is_dir() {
            continue;
        }
        let mut s = ProfileStatus {
            name: rel.clone(),
            is_default: defaults.contains(&rel),
            installed: false,
            enabled: Some(false),
            private_browsing: Some(false),
            website_access_all: None,
            note: None,
        };

        if let Ok(raw) = std::fs::read_to_string(dir.join("extensions.json")) {
            if let Ok(data) = serde_json::from_str::<Value>(&raw) {
                if let Some(addons) = data.get("addons").and_then(|v| v.as_array()) {
                    if let Some(addon) = addons
                        .iter()
                        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(FIREFOX_ID))
                    {
                        if firefox_addon_counts_as_installed(addon, &dir) {
                            s.installed = true;
                            s.enabled = Some(firefox_addon_enabled(addon));
                        }
                    }
                }
            }
        }

        if cfg!(debug_assertions) && !s.installed && firefox_debug_temp_extension_matches(&dir) {
            s.installed = true;
            s.enabled = Some(true);
            s.note = Some("Temporary about:debugging extension".to_string());
        }

        if let Ok(raw) = std::fs::read_to_string(dir.join("extension-preferences.json")) {
            if let Ok(data) = serde_json::from_str::<Value>(&raw) {
                let allowed = data
                    .get(FIREFOX_ID)
                    .and_then(|v| v.get("permissions"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .any(|v| v.as_str() == Some("internal:privateBrowsingAllowed"))
                    })
                    .unwrap_or(false);
                s.private_browsing = Some(allowed);
            }
        }

        profiles.push(s);
    }

    Some(BrowserStatus {
        present: running,
        installed: true,
        profiles,
        error: None,
        duplicate_extensions: None,
        needs_fda_access: false,
        native_host_ready: false,
    })
}

fn firefox_debug_temp_extension_matches(profile_dir: &Path) -> bool {
    let prefs = match std::fs::read_to_string(profile_dir.join("prefs.js")) {
        Ok(raw) => raw,
        Err(_) => return false,
    };

    let Some(ext_dir) = parse_firefox_tmp_ext_dir(&prefs) else {
        return false;
    };

    let manifest_path = PathBuf::from(ext_dir).join("manifest.json");
    let manifest = match std::fs::read_to_string(manifest_path) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let data: Value = match serde_json::from_str(&manifest) {
        Ok(v) => v,
        Err(_) => return false,
    };

    data.get("browser_specific_settings")
        .and_then(|v| v.get("gecko"))
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        == Some(FIREFOX_ID)
}

fn parse_firefox_tmp_ext_dir(prefs_js: &str) -> Option<String> {
    const KEY: &str = r#"user_pref("devtools.aboutdebugging.tmpExtDirPath","#;

    let line = prefs_js
        .lines()
        .find(|line| line.trim_start().starts_with(KEY))?;
    let rest = line.trim_start().strip_prefix(KEY)?.trim();
    let raw = rest.strip_suffix(");")?.trim();
    serde_json::from_str::<String>(raw).ok()
}

fn read_firefox_profiles(root: &Path) -> (Vec<String>, Vec<String>) {
    let ini_path = root.join("profiles.ini");
    let mut defaults = vec![];
    let mut profile_dirs = vec![];

    if let Ok(ini) = std::fs::read_to_string(&ini_path) {
        // [InstallXXXX] Default=<path> is authoritative for modern Firefox.
        let mut in_install_block = false;
        for line in ini.lines() {
            let line = line.trim();
            if line.starts_with('[') && line.ends_with(']') {
                in_install_block = line.starts_with("[Install");
            } else if in_install_block {
                if let Some(rest) = line.strip_prefix("Default=") {
                    defaults.push(rest.trim().to_string());
                }
            }
            if let Some(rest) = line.strip_prefix("Path=") {
                profile_dirs.push(rest.trim().to_string());
            }
        }
    } else {
        // Fallback: list the Profiles/ subdir if present.
        let profiles_dir = root.join("Profiles");
        if let Ok(rd) = std::fs::read_dir(&profiles_dir) {
            for entry in rd.flatten() {
                profile_dirs.push(format!("Profiles/{}", entry.file_name().to_string_lossy()));
            }
        }
    }
    (profile_dirs, defaults)
}

// ---- Chromium (Chrome / Brave / Edge) --------------------------------------

#[derive(Copy, Clone)]
enum ChromiumBrowser {
    Chrome,
    Brave,
    Edge,
}

/// True if any process with one of the given names is currently
/// running. We treat "present" as "running" rather than "installed"
/// because install paths vary widely (Setapp, manual relocations,
/// portable installs, etc.) and stale profile dirs remain after
/// uninstall. The compliance banner only matters when the user has
/// the browser open; if it's closed, no nag.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn is_process_running(names: &[&str]) -> bool {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes().values().any(|p| {
        let pname = p.name().to_string_lossy().to_string();
        names.iter().any(|n| pname.eq_ignore_ascii_case(n))
    })
}
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn is_process_running(_names: &[&str]) -> bool {
    false
}

impl ChromiumBrowser {
    /// True when the browser app appears to be present on disk
    /// (bundle in /Applications or ~/Applications on macOS, the
    /// profile-data dir on Windows/Linux). Used by the migration
    /// onboarding to decide whether to surface a row.
    ///
    /// We only consider the profile-dir alone insufficient on macOS
    /// because empty/stub Chrome profile dirs sometimes exist on
    /// systems that never had Chrome installed (e.g. via a Google
    /// Updater leftover or a one-off Cast/Drive integration). The
    /// actual .app bundle existing is the firmer signal.
    fn app_installed(self) -> bool {
        #[cfg(target_os = "macos")]
        {
            let bundle = match self {
                ChromiumBrowser::Chrome => "Google Chrome.app",
                ChromiumBrowser::Brave => "Brave Browser.app",
                ChromiumBrowser::Edge => "Microsoft Edge.app",
            };
            let candidates = [
                PathBuf::from("/Applications").join(bundle),
                dirs::home_dir()
                    .map(|h| h.join("Applications").join(bundle))
                    .unwrap_or_default(),
            ];
            candidates.iter().any(|p| p.exists())
        }
        #[cfg(target_os = "windows")]
        {
            let name = match self {
                ChromiumBrowser::Chrome => "chrome",
                ChromiumBrowser::Brave => "brave",
                ChromiumBrowser::Edge => "edge",
            };
            find_browser_exe(name).is_some()
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            self.root().map(|p| p.exists()).unwrap_or(false)
        }
    }

    /// Install + running flags only — no profile-dir reads (macOS onboarding).
    #[allow(dead_code)] // used on macOS; dead on Windows
    fn presence_only(self) -> BrowserStatus {
        BrowserStatus {
            present: self.app_present(),
            installed: self.app_installed(),
            profiles: vec![],
            error: None,
            duplicate_extensions: None,
            needs_fda_access: false,
            native_host_ready: false,
        }
    }

    fn app_present(self) -> bool {
        // Process names as reported by `sysinfo` (which mirrors what
        // /bin/ps and tasklist see on each platform).
        #[cfg(target_os = "macos")]
        let names: &[&str] = match self {
            ChromiumBrowser::Chrome => &["Google Chrome", "Google Chrome Helper"],
            ChromiumBrowser::Brave => &["Brave Browser", "Brave Browser Helper"],
            ChromiumBrowser::Edge => &["Microsoft Edge", "Microsoft Edge Helper"],
        };
        #[cfg(target_os = "windows")]
        let names: &[&str] = match self {
            ChromiumBrowser::Chrome => &["chrome.exe"],
            ChromiumBrowser::Brave => &["brave.exe"],
            ChromiumBrowser::Edge => &["msedge.exe"],
        };
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let names: &[&str] = match self {
            ChromiumBrowser::Chrome => &["chrome", "google-chrome"],
            ChromiumBrowser::Brave => &["brave", "brave-browser"],
            ChromiumBrowser::Edge => &["microsoft-edge", "msedge"],
        };
        is_process_running(names)
    }

    fn root(self) -> Option<PathBuf> {
        #[cfg(target_os = "macos")]
        {
            let home = dirs::home_dir()?;
            let p = match self {
                ChromiumBrowser::Chrome => "Library/Application Support/Google/Chrome",
                ChromiumBrowser::Brave => "Library/Application Support/BraveSoftware/Brave-Browser",
                ChromiumBrowser::Edge => "Library/Application Support/Microsoft Edge",
            };
            Some(home.join(p))
        }
        #[cfg(target_os = "windows")]
        {
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
            let p = match self {
                ChromiumBrowser::Chrome => r"Google\Chrome\User Data",
                ChromiumBrowser::Brave => r"BraveSoftware\Brave-Browser\User Data",
                ChromiumBrowser::Edge => r"Microsoft\Edge\User Data",
            };
            Some(local.join(p))
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            let home = dirs::home_dir()?;
            let p = match self {
                ChromiumBrowser::Chrome => ".config/google-chrome",
                ChromiumBrowser::Brave => ".config/BraveSoftware/Brave-Browser",
                ChromiumBrowser::Edge => ".config/microsoft-edge",
            };
            Some(home.join(p))
        }
    }
}

fn scan_chromium(b: ChromiumBrowser) -> Option<BrowserStatus> {
    let running = b.app_present();
    let installed = b.app_installed();
    let root = b.root()?;
    if !installed || !root.exists() {
        return Some(BrowserStatus {
            present: running,
            installed,
            profiles: vec![],
            error: None,
            duplicate_extensions: None,
            needs_fda_access: false,
            native_host_ready: false,
        });
    }

    // Discover profiles via "Local State" first, dir scan as fallback.
    let mut profile_names: Vec<String> = vec![];
    let mut last_used: Option<String> = None;
    if let Ok(raw) = std::fs::read_to_string(root.join("Local State")) {
        if let Ok(data) = serde_json::from_str::<Value>(&raw) {
            if let Some(cache) = data
                .get("profile")
                .and_then(|p| p.get("info_cache"))
                .and_then(|v| v.as_object())
            {
                profile_names = cache.keys().cloned().collect();
            }
            last_used = data
                .get("profile")
                .and_then(|p| p.get("last_used"))
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }
    if profile_names.is_empty() {
        if let Ok(rd) = std::fs::read_dir(&root) {
            for entry in rd.flatten() {
                if entry.path().is_dir() && entry.path().join("Preferences").exists() {
                    profile_names.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }

    let mut profiles = vec![];
    for name in profile_names {
        let dir = root.join(&name);
        let is_default = Some(name.as_str()) == last_used.as_deref()
            || (last_used.is_none() && name == "Default");

        let mut merged_settings = serde_json::Map::new();
        for filename in ["Preferences", "Secure Preferences"] {
            if let Ok(raw) = std::fs::read_to_string(dir.join(filename)) {
                if let Ok(data) = serde_json::from_str::<Value>(&raw) {
                    if let Some(settings) = data
                        .get("extensions")
                        .and_then(|e| e.get("settings"))
                        .and_then(|v| v.as_object())
                    {
                        for (k, v) in settings {
                            merged_settings.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }

        let mut s = ProfileStatus {
            name,
            is_default,
            installed: false,
            enabled: Some(false),
            private_browsing: Some(false),
            website_access_all: None,
            note: None,
        };

        // A profile can hold *multiple* matching entries — typically a
        // stale stub from a previous Web-Store install sitting next to
        // an unpacked dev extension. `find_map` would silently pick
        // the first one, which is usually the empty stub: installed=
        // true with everything else null. That makes the compliance
        // check fail and the enforcer kill the browser even when the
        // real extension is loaded and configured correctly. Score
        // every matching entry and keep the best.
        //
        // ALSO: Brave (and Edge) keep a webstore-allowlist stub for
        // extensions the user has merely *seen* in the store (e.g.,
        // hovered over the install button) — `{ "active_bit": false,
        // "allowlist": 1 }` with no `state`, `manifest`, or `path`.
        // Treating that as "installed" makes the migration UI show
        // "Allow in private browsing" for browsers that don't actually
        // have the extension. Require a real install signal.
        let is_real_install = |ext: &Value| -> bool {
            // Most reliable: a manifest object means Chrome wrote
            // metadata about an actual on-disk extension.
            if ext.get("manifest").and_then(|v| v.as_object()).is_some() {
                return true;
            }
            // path is set when an unpacked or store install resolved
            // to a directory on disk.
            if ext.get("path").and_then(|v| v.as_str()).is_some() {
                return true;
            }
            // Explicit state field also indicates Chrome made a real
            // install/disable decision (state 0 = disabled, 1 =
            // enabled, etc). Allowlist-only stubs have no state.
            if ext.get("state").and_then(|v| v.as_i64()).is_some() {
                return true;
            }
            false
        };

        let view = |ext: &Value| {
            let state = ext.get("state").and_then(|v| v.as_i64());
            let has_disable_reasons = match ext.get("disable_reasons") {
                Some(Value::Array(a)) => !a.is_empty(),
                Some(Value::Number(n)) => n.as_i64().map(|x| x != 0).unwrap_or(false),
                _ => false,
            };
            let enabled = state == Some(1) || (state.is_none() && !has_disable_reasons);
            let incognito = ext
                .get("incognito")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            (enabled, incognito)
        };

        let best = chromium_ids()
            .iter()
            .filter_map(|id| merged_settings.get(id))
            .filter(|ext| is_real_install(ext))
            .map(|ext| {
                let (enabled, incognito) = view(ext);
                (enabled, incognito, ext)
            })
            .max_by_key(|(enabled, incognito, _)| (*enabled as u8, *incognito as u8));

        if let Some((enabled, incognito, _ext)) = best {
            s.installed = true;
            s.enabled = Some(enabled);
            s.private_browsing = Some(incognito);
        }

        profiles.push(s);
    }

    Some(BrowserStatus {
        present: running,
        installed: true,
        profiles,
        error: None,
        duplicate_extensions: None,
        needs_fda_access: false,
        native_host_ready: false,
    })
}

// ---- Safari (macOS only) --------------------------------------------------

#[cfg(target_os = "macos")]
pub fn safari_extensions_plist_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(
        "Library/Containers/com.apple.Safari/Data/Library/Safari/WebExtensions/Extensions.plist",
    ))
}

#[cfg(target_os = "macos")]
fn safari_profiles_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join("Library/Containers/com.apple.Safari/Data/Library/Safari/Profiles"))
}

/// True when this ReDD Blocker.app still has a Safari Web Extension
/// `.appex` in `Contents/PlugIns/` (legacy builds only — release builds
/// no longer embed one). Used to short-circuit plist-based install
/// detection when the host bundle carries its own copy.
#[cfg(target_os = "macos")]
fn embedded_safari_extension_present() -> bool {
    // current_exe() resolves to .../ReDD Blocker.app/Contents/MacOS/redd-block.
    // Walk up two levels to reach .../Contents and look for our .appex.
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(macos_dir) = exe.parent() else {
        return false;
    };
    let Some(contents_dir) = macos_dir.parent() else {
        return false;
    };
    contents_dir
        .join("PlugIns/ReDD Focus Extension.appex")
        .is_dir()
}

#[cfg(target_os = "macos")]
fn safari_extensions_plist_paths() -> (Vec<(String, bool, PathBuf)>, Option<SafariPlistScanError>) {
    let mut paths = Vec::new();
    if let Some(path) = safari_extensions_plist_path() {
        paths.push(("(Default Safari profile)".to_string(), true, path));
    }

    let Some(profiles_dir) = safari_profiles_dir() else {
        return (paths, None);
    };
    log::info!(
        "tcc-probe: about to read_dir (Safari profiles container) {}",
        profiles_dir.display()
    );
    let entries = match std::fs::read_dir(profiles_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (paths, None),
        Err(e) => return (paths, Some(safari_plist_io_error(e))),
    };
    for entry in entries.flatten() {
        let profile_dir = entry.path();
        if !profile_dir.is_dir() {
            continue;
        }
        let path = profile_dir.join("WebExtensions/Extensions.plist");
        if path.exists() {
            let name = profile_dir
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| format!("Safari profile {s}"))
                .unwrap_or_else(|| "Safari profile".to_string());
            paths.push((name, false, path));
        }
    }
    (paths, None)
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SafariPlistScanError {
    Missing,
    PermissionDenied,
    Invalid(String),
}

#[cfg(target_os = "macos")]
impl SafariPlistScanError {
    fn note(&self) -> String {
        match self {
            SafariPlistScanError::Missing => {
                "Safari extension settings plist not found".to_string()
            }
            SafariPlistScanError::PermissionDenied => "Full Disk Access required".to_string(),
            SafariPlistScanError::Invalid(e) => {
                format!("Could not read Safari extension settings: {e}")
            }
        }
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct SafariPlistStatus {
    installed: bool,
    enabled: Option<bool>,
    private_browsing: Option<bool>,
    website_access_all: Option<bool>,
}

#[cfg(target_os = "macos")]
pub fn scan_safari_extensions_plist() -> Result<Option<(bool, bool, bool)>, SafariPlistScanError> {
    let path = safari_extensions_plist_path().ok_or(SafariPlistScanError::Missing)?;
    scan_safari_extensions_plist_at(&path).map(safari_plist_status_tuple)
}

#[cfg(target_os = "macos")]
fn scan_safari_extensions_plist_at(path: &Path) -> Result<SafariPlistStatus, SafariPlistScanError> {
    log::info!(
        "tcc-probe: about to read (Safari WebExtensions plist) {}",
        path.display()
    );
    let bytes = std::fs::read(path).map_err(safari_plist_io_error)?;
    parse_safari_extensions_plist(&bytes, &safari_extension_keys())
}

#[cfg(target_os = "macos")]
fn safari_plist_io_error(e: std::io::Error) -> SafariPlistScanError {
    if e.kind() == std::io::ErrorKind::NotFound {
        SafariPlistScanError::Missing
    } else if e.kind() == std::io::ErrorKind::PermissionDenied {
        SafariPlistScanError::PermissionDenied
    } else {
        SafariPlistScanError::Invalid(e.to_string())
    }
}

#[cfg(target_os = "macos")]
fn safari_plist_status_tuple(status: SafariPlistStatus) -> Option<(bool, bool, bool)> {
    if status.installed {
        Some((
            status.enabled.unwrap_or(false),
            status.private_browsing.unwrap_or(false),
            status.website_access_all.unwrap_or(false),
        ))
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct SafariExtensionPlistEntry {
    present: bool,
    enabled: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct SafariDuplicatePlistScan {
    bundled: SafariExtensionPlistEntry,
    standalone: SafariExtensionPlistEntry,
}

#[cfg(target_os = "macos")]
fn safari_extension_entry_in_plist_dict(
    dict: &plist::Dictionary,
    plist_key: &str,
) -> SafariExtensionPlistEntry {
    let Some(value) = dict.get(plist_key) else {
        return SafariExtensionPlistEntry::default();
    };
    let Some(ext) = value.as_dictionary() else {
        return SafariExtensionPlistEntry::default();
    };
    if ext.contains_key("RemovedDate") {
        return SafariExtensionPlistEntry::default();
    }
    let enabled = ext
        .get("Enabled")
        .and_then(|v| v.as_boolean())
        .unwrap_or(false);
    SafariExtensionPlistEntry {
        present: true,
        enabled,
    }
}

#[cfg(target_os = "macos")]
fn parse_safari_duplicate_extensions_at(
    path: &Path,
) -> Result<SafariDuplicatePlistScan, SafariPlistScanError> {
    log::info!(
        "tcc-probe: about to read (Safari duplicate scan) {}",
        path.display()
    );
    let bytes = std::fs::read(path).map_err(safari_plist_io_error)?;
    parse_safari_duplicate_extensions(bytes.as_slice())
}

#[cfg(target_os = "macos")]
fn parse_safari_duplicate_extensions(
    bytes: &[u8],
) -> Result<SafariDuplicatePlistScan, SafariPlistScanError> {
    let root = plist::Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|e| SafariPlistScanError::Invalid(e.to_string()))?;
    let Some(dict) = root.as_dictionary() else {
        return Err(SafariPlistScanError::Invalid(
            "root is not a dictionary".to_string(),
        ));
    };
    Ok(SafariDuplicatePlistScan {
        bundled: safari_extension_entry_in_plist_dict(dict, SAFARI_BUNDLED_PLIST_KEY),
        standalone: safari_extension_entry_in_plist_dict(dict, SAFARI_STANDALONE_PLIST_KEY),
    })
}

#[cfg(target_os = "macos")]
fn safari_extensions_both_enabled_conflict(
    embedded: bool,
    mut bundled_present: bool,
    mut bundled_enabled: bool,
    standalone_present: bool,
    standalone_enabled: bool,
) -> bool {
    if embedded {
        bundled_present = true;
    }
    if bundled_present && !bundled_enabled {
        if let Ok(state) =
            crate::safari_services::extension_state(crate::native_host_install::SAFARI_EXT_ID)
        {
            bundled_enabled = state.enabled;
        }
    }
    bundled_present && standalone_present && bundled_enabled && standalone_enabled
}

#[cfg(target_os = "macos")]
fn scan_safari_duplicate_extensions(
    has_fda: bool,
    embedded: bool,
) -> Option<SafariDuplicateExtensions> {
    if !has_fda {
        return None;
    }
    let (paths, _) = safari_extensions_plist_paths();
    let mut bundled_present = false;
    let mut bundled_enabled = false;
    let mut standalone_present = false;
    let mut standalone_enabled = false;
    for (_, _, path) in paths {
        match parse_safari_duplicate_extensions_at(&path) {
            Ok(scan) => {
                if scan.bundled.present {
                    bundled_present = true;
                    bundled_enabled |= scan.bundled.enabled;
                }
                if scan.standalone.present {
                    standalone_present = true;
                    standalone_enabled |= scan.standalone.enabled;
                }
            }
            Err(SafariPlistScanError::Missing) => {}
            Err(e) => {
                log::info!(
                    "safari duplicate scan skipped for {}: {}",
                    path.display(),
                    e.note()
                );
            }
        }
    }
    if safari_extensions_both_enabled_conflict(
        embedded,
        bundled_present,
        bundled_enabled,
        standalone_present,
        standalone_enabled,
    ) {
        Some(SafariDuplicateExtensions { detected: true })
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
#[allow(dead_code)] // used by the non-macOS scan path
fn firefox_presence_only() -> BrowserStatus {
    BrowserStatus {
        present: firefox_app_present(),
        installed: firefox_app_installed(),
        profiles: vec![],
        error: None,
        duplicate_extensions: None,
        needs_fda_access: false,
        native_host_ready: false,
    }
}

#[cfg(target_os = "macos")]
fn safari_presence_only() -> BrowserStatus {
    let installed = Path::new("/Applications/Safari.app").exists()
        || dirs::home_dir()
            .map(|h| h.join("Applications/Safari.app").exists())
            .unwrap_or(false);
    let running = is_process_running(&["Safari"]);
    BrowserStatus {
        present: running,
        installed,
        profiles: vec![],
        error: None,
        duplicate_extensions: None,
        needs_fda_access: false,
        native_host_ready: false,
    }
}

#[cfg(target_os = "macos")]
fn parse_safari_extensions_plist(
    bytes: &[u8],
    safari_keys: &[String],
) -> Result<SafariPlistStatus, SafariPlistScanError> {
    let root = plist::Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|e| SafariPlistScanError::Invalid(e.to_string()))?;
    let Some(dict) = root.as_dictionary() else {
        return Err(SafariPlistScanError::Invalid(
            "root is not a dictionary".to_string(),
        ));
    };

    let mut best: Option<SafariPlistStatus> = None;
    for (key, value) in dict {
        if !safari_keys.iter().any(|expected| key == expected) {
            continue;
        }
        let Some(ext) = value.as_dictionary() else {
            continue;
        };
        if ext.contains_key("RemovedDate") {
            continue;
        }
        let enabled = ext
            .get("Enabled")
            .and_then(|v| v.as_boolean())
            .unwrap_or(false);
        let private_browsing = ext
            .get("AllowInPrivateBrowsing")
            .and_then(|v| v.as_boolean())
            .unwrap_or(false);
        let website_access_all = safari_grants_all_websites(ext);
        let status = SafariPlistStatus {
            installed: true,
            enabled: Some(enabled),
            private_browsing: Some(private_browsing),
            website_access_all: Some(website_access_all),
        };
        let score = (
            enabled as u8,
            private_browsing as u8,
            website_access_all as u8,
        );
        let current_score = best
            .as_ref()
            .map(|current| {
                (
                    (current.enabled == Some(true)) as u8,
                    (current.private_browsing == Some(true)) as u8,
                    (current.website_access_all == Some(true)) as u8,
                )
            })
            .unwrap_or((0, 0, 0));
        if best.is_none() || score > current_score {
            best = Some(status);
        }
    }

    Ok(best.unwrap_or(SafariPlistStatus {
        installed: false,
        enabled: Some(false),
        private_browsing: Some(false),
        website_access_all: Some(false),
    }))
}

#[cfg(target_os = "macos")]
fn scan_safari() -> BrowserStatus {
    log::info!("tcc-probe: profile_scan::scan_safari() entered");
    let running = is_process_running(&["Safari"]);
    let mut profiles = Vec::new();
    let mut error = None;
    let mut needs_fda_access = crate::cross_app_consent::safari_fda_was_revoked();
    let mut has_fda = crate::cross_app_consent::safari_fda_effective();

    if has_fda {
        let (plist_paths, profile_list_error) = safari_extensions_plist_paths();
        for (name, is_default, path) in plist_paths {
            match scan_safari_extensions_plist_at(&path) {
                Ok(status) => profiles.push(ProfileStatus {
                    name,
                    is_default,
                    installed: status.installed,
                    enabled: status.enabled,
                    private_browsing: status.private_browsing,
                    website_access_all: status.website_access_all,
                    note: None,
                }),
                Err(e) => {
                    if e == SafariPlistScanError::PermissionDenied {
                        crate::cross_app_consent::clear_fda_marker_on_safari_plist_denied();
                        has_fda = false;
                        needs_fda_access = true;
                    }
                    let note = e.note();
                    if error.is_none() {
                        error = Some(note.clone());
                    }
                    profiles.push(ProfileStatus {
                        name,
                        is_default,
                        installed: false,
                        enabled: Some(false),
                        private_browsing: Some(false),
                        website_access_all: Some(false),
                        note: Some(note),
                    });
                }
            }
        }
        if let Some(e) = profile_list_error {
            if e == SafariPlistScanError::PermissionDenied {
                crate::cross_app_consent::clear_fda_marker_on_safari_plist_denied();
                has_fda = false;
                needs_fda_access = true;
            }
            let note = e.note();
            if error.is_none() {
                error = Some(note.clone());
            }
            profiles.push(ProfileStatus {
                name: "Safari profiles".to_string(),
                is_default: false,
                installed: false,
                enabled: Some(false),
                private_browsing: Some(false),
                website_access_all: Some(false),
                note: Some(note),
            });
        }
    } else {
        needs_fda_access = true;
        log::info!("tcc-probe: scan_safari skipping plist (Safari FDA not effective)");
    }

    if profiles.is_empty() {
        let note = if has_fda {
            SafariPlistScanError::Missing.note()
        } else {
            SafariPlistScanError::PermissionDenied.note()
        };
        error = Some(note.clone());
        profiles.push(ProfileStatus {
            name: "(Default Safari profile)".to_string(),
            is_default: true,
            installed: false,
            enabled: Some(false),
            private_browsing: Some(false),
            website_access_all: Some(false),
            note: Some(note),
        });
    }

    let embedded = embedded_safari_extension_present();
    let duplicate_extensions = scan_safari_duplicate_extensions(has_fda, embedded);

    if crate::cross_app_consent::safari_fda_was_revoked() {
        needs_fda_access = true;
    }

    log::info!(
        "tcc-probe: profile_scan::scan_safari() exited (running={running}, has_fda={has_fda}, duplicate={duplicate_extensions:?})"
    );
    BrowserStatus {
        present: running,
        installed: true,
        profiles,
        error,
        duplicate_extensions,
        needs_fda_access,
        native_host_ready: false,
    }
}

#[cfg(target_os = "macos")]
fn safari_grants_all_websites(ext: &plist::Dictionary) -> bool {
    let has_grant = safari_origin_dict_contains(ext, "GrantedPermissionOrigins", "*://*/*")
        || safari_origin_dict_contains(ext, "GrantedPermissionOrigins", "<all_urls>");
    let revoked = safari_origin_dict_contains(ext, "RevokedPermissionOrigins", "*://*/*")
        || safari_origin_dict_contains(ext, "RevokedPermissionOrigins", "<all_urls>");
    has_grant && !revoked
}

#[cfg(target_os = "macos")]
fn safari_origin_dict_contains(ext: &plist::Dictionary, dict_key: &str, origin: &str) -> bool {
    ext.get(dict_key)
        .and_then(|v| v.as_dictionary())
        .map(|origins| origins.contains_key(origin))
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn scan_safari() -> BrowserStatus {
    BrowserStatus {
        present: false,
        installed: false,
        profiles: vec![],
        error: Some("Safari is macOS-only".to_string()),
        duplicate_extensions: None,
        needs_fda_access: false,
        native_host_ready: false,
    }
}

/// True if every running-and-present Chromium/Firefox browser has a
/// compliant default profile. Safari is stricter: every Safari profile
/// plist we can see must report installed+enabled+privateBrowsing and
/// all-website access. Used by onboarding to gate the backend switch.
///
fn default_profile_compliant(b: &BrowserStatus) -> bool {
    let def = b
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| b.profiles.first());
    matches!(
        def,
        Some(p) if p.installed
            && p.enabled == Some(true)
            && p.private_browsing == Some(true)
            && p.website_access_all.unwrap_or(true)
    )
}

pub fn compliant(result: &ScanResult) -> bool {
    let chromium_ok = [&result.chrome, &result.brave, &result.edge]
        .iter()
        .all(|b| !b.present || default_profile_compliant(b));
    let firefox_ok = !result.firefox.present
        || (default_profile_compliant(&result.firefox) && {
            #[cfg(target_os = "macos")]
            {
                result.firefox.native_host_ready
            }
            #[cfg(not(target_os = "macos"))]
            {
                true
            }
        });
    let safari_ok = !result.safari.present
        || (!result.safari.profiles.is_empty()
            && result.safari.profiles.iter().all(safari_profile_passes));
    chromium_ok && firefox_ok && safari_ok
}

fn safari_profile_passes(p: &ProfileStatus) -> bool {
    // Mirrors the post-bridge JS browserComplianceStatus logic in
    // src/app.js: the Swift bridge gives us a definitive `enabled`
    // (the gating step), but private-browsing and all-sites access
    // are only knowable via the FDA-protected plist. Treat null as
    // "trust the user has done it" so we don't keep dragging users
    // through a Full Disk Access prompt for fields they can verify
    // themselves in Safari Settings → Extensions. Definitive `false`
    // still fails the check.
    p.installed
        && p.enabled == Some(true)
        && p.private_browsing != Some(false)
        && p.website_access_all != Some(false)
}

#[cfg(test)]
mod firefox_addon_tests {
    use super::*;
    use std::fs;

    fn test_profile_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "redd_block_firefox_scan_test_{}_{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    fn addon_json(extra: serde_json::Map<String, Value>) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), Value::String(FIREFOX_ID.into()));
        m.insert("type".into(), Value::String("extension".into()));
        for (k, v) in extra {
            m.insert(k, v);
        }
        Value::Object(m)
    }

    #[test]
    fn firefox_counts_disabled_addon_as_installed() {
        let dir = test_profile_dir("disabled");
        let addon = addon_json(serde_json::Map::from_iter([
            ("visible".into(), Value::Bool(true)),
            ("active".into(), Value::Bool(false)),
            ("userDisabled".into(), Value::Bool(true)),
        ]));
        assert!(firefox_addon_counts_as_installed(&addon, &dir));
        assert!(!firefox_addon_enabled(&addon));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn firefox_ignores_pending_uninstall() {
        let dir = test_profile_dir("pending_uninstall");
        let addon = addon_json(serde_json::Map::from_iter([
            ("visible".into(), Value::Bool(true)),
            ("pendingUninstall".into(), Value::Bool(true)),
            ("active".into(), Value::Bool(false)),
            ("userDisabled".into(), Value::Bool(true)),
        ]));
        assert!(!firefox_addon_counts_as_installed(&addon, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn firefox_ignores_invisible_catalog_row() {
        let dir = test_profile_dir("invisible");
        let addon = addon_json(serde_json::Map::from_iter([
            ("visible".into(), Value::Bool(false)),
            ("active".into(), Value::Bool(false)),
            ("userDisabled".into(), Value::Bool(true)),
        ]));
        assert!(!firefox_addon_counts_as_installed(&addon, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn firefox_ignores_stale_path() {
        let dir = test_profile_dir("stale_path");
        let rel = "extensions/stale.xpi";
        let addon = addon_json(serde_json::Map::from_iter([
            ("visible".into(), Value::Bool(true)),
            ("path".into(), Value::String(rel.into())),
            ("active".into(), Value::Bool(false)),
            ("userDisabled".into(), Value::Bool(true)),
        ]));
        assert!(!firefox_addon_counts_as_installed(&addon, &dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn firefox_accepts_path_on_disk() {
        let dir = test_profile_dir("on_disk");
        let rel = "extensions/redd.xpi";
        fs::create_dir_all(dir.join("extensions")).expect("mkdir");
        fs::write(dir.join(rel), b"xpi").expect("write");
        let addon = addon_json(serde_json::Map::from_iter([
            ("visible".into(), Value::Bool(true)),
            ("path".into(), Value::String(rel.into())),
            ("active".into(), Value::Bool(true)),
            ("userDisabled".into(), Value::Bool(false)),
        ]));
        assert!(firefox_addon_counts_as_installed(&addon, &dir));
        assert!(firefox_addon_enabled(&addon));
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn parse(body: &str) -> SafariPlistStatus {
        let keys = vec!["com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)".to_string()];
        parse_safari_extensions_plist(body.as_bytes(), &keys).expect("plist parses")
    }

    fn plist(entries: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
{entries}
</dict>
</plist>"#
        )
    }

    fn entry(
        key: &str,
        enabled: bool,
        private: bool,
        website_access_all: bool,
        revoked_all: bool,
        removed: bool,
    ) -> String {
        let removed_date = if removed {
            "<key>RemovedDate</key><date>2026-04-26T17:33:08Z</date>"
        } else {
            ""
        };
        let granted_origins = if website_access_all {
            r#"<key>GrantedPermissionOrigins</key>
  <dict>
    <key>*://*/*</key><date>4001-01-01T00:00:00Z</date>
  </dict>"#
        } else {
            r#"<key>GrantedPermissionOrigins</key><dict/>"#
        };
        let revoked_origins = if revoked_all {
            r#"<key>RevokedPermissionOrigins</key>
  <dict>
    <key>*://*/*</key><date>4001-01-01T00:00:00Z</date>
  </dict>"#
        } else {
            r#"<key>RevokedPermissionOrigins</key><dict/>"#
        };
        format!(
            r#"<key>{key}</key>
<dict>
  <key>Enabled</key><{enabled}/>
  <key>AllowInPrivateBrowsing</key><{private}/>
  {granted_origins}
  <key>GrantedPermissions</key>
  <dict/>
  {revoked_origins}
  {removed_date}
</dict>"#,
            enabled = if enabled { "true" } else { "false" },
            private = if private { "true" } else { "false" },
        )
    }

    #[test]
    fn safari_plist_enabled_and_private_allowed() {
        let status = parse(&plist(&entry(
            "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
            true,
            true,
            true,
            false,
            false,
        )));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(true));
        assert_eq!(status.private_browsing, Some(true));
        assert_eq!(status.website_access_all, Some(true));
    }

    #[test]
    fn safari_plist_enabled_private_denied() {
        let status = parse(&plist(&entry(
            "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
            true,
            false,
            true,
            false,
            false,
        )));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(true));
        assert_eq!(status.private_browsing, Some(false));
        assert_eq!(status.website_access_all, Some(true));
    }

    #[test]
    fn safari_plist_disabled() {
        let status = parse(&plist(&entry(
            "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
            false,
            true,
            true,
            false,
            false,
        )));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(false));
        assert_eq!(status.private_browsing, Some(true));
        assert_eq!(status.website_access_all, Some(true));
    }

    #[test]
    fn safari_plist_requires_all_website_access() {
        let status = parse(&plist(&entry(
            "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
            true,
            true,
            false,
            false,
            false,
        )));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(true));
        assert_eq!(status.private_browsing, Some(true));
        assert_eq!(status.website_access_all, Some(false));
    }

    #[test]
    fn safari_plist_all_website_access_revoked_fails() {
        let status = parse(&plist(&entry(
            "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
            true,
            true,
            true,
            true,
            false,
        )));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(true));
        assert_eq!(status.private_browsing, Some(true));
        assert_eq!(status.website_access_all, Some(false));
    }

    #[test]
    fn safari_plist_ignores_removed_entries() {
        let entries = format!(
            "{}\n{}",
            entry(
                "com.ulriklyngs.mind-shield.old (7YEYWQKK25)",
                true,
                true,
                true,
                false,
                true
            ),
            entry(
                "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
                true,
                false,
                false,
                false,
                false
            ),
        );
        let status = parse(&plist(&entries));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(true));
        assert_eq!(status.private_browsing, Some(false));
        assert_eq!(status.website_access_all, Some(false));
    }

    fn parse_duplicate(body: &str) -> SafariDuplicatePlistScan {
        parse_safari_duplicate_extensions(body.as_bytes()).expect("plist parses")
    }

    #[test]
    fn safari_duplicate_detects_both_enabled() {
        let entries = format!(
            "{}\n{}",
            entry(SAFARI_BUNDLED_PLIST_KEY, true, true, true, false, false,),
            entry(SAFARI_STANDALONE_PLIST_KEY, true, true, true, false, false,),
        );
        let scan = parse_duplicate(&plist(&entries));
        assert!(scan.bundled.present && scan.bundled.enabled);
        assert!(scan.standalone.present && scan.standalone.enabled);
        assert!(safari_extensions_both_enabled_conflict(
            true,
            scan.bundled.present,
            scan.bundled.enabled,
            scan.standalone.present,
            scan.standalone.enabled,
        ));
    }

    #[test]
    fn safari_duplicate_clears_when_standalone_disabled() {
        let entries = format!(
            "{}\n{}",
            entry(SAFARI_BUNDLED_PLIST_KEY, true, true, true, false, false,),
            entry(SAFARI_STANDALONE_PLIST_KEY, false, true, true, false, false,),
        );
        let scan = parse_duplicate(&plist(&entries));
        assert!(scan.bundled.present && scan.bundled.enabled);
        assert!(scan.standalone.present && !scan.standalone.enabled);
        assert!(!safari_extensions_both_enabled_conflict(
            true,
            scan.bundled.present,
            scan.bundled.enabled,
            scan.standalone.present,
            scan.standalone.enabled,
        ));
    }

    #[test]
    fn safari_duplicate_ignores_removed_standalone() {
        let entries = format!(
            "{}\n{}",
            entry(SAFARI_BUNDLED_PLIST_KEY, true, true, true, false, false,),
            entry(SAFARI_STANDALONE_PLIST_KEY, true, true, true, false, true,),
        );
        let scan = parse_duplicate(&plist(&entries));
        assert!(scan.bundled.present);
        assert!(!scan.standalone.present);
    }

    #[test]
    fn safari_plist_ignores_stale_team_id_entry() {
        let entries = format!(
            "{}\n{}",
            entry(
                "com.ulriklyngs.mind-shield.mind-shield (7YEYWQKK25)",
                true,
                true,
                true,
                false,
                false
            ),
            entry(
                "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
                true,
                true,
                false,
                true,
                false
            ),
        );
        let status = parse(&plist(&entries));
        assert_eq!(status.installed, true);
        assert_eq!(status.enabled, Some(true));
        assert_eq!(status.private_browsing, Some(true));
        assert_eq!(status.website_access_all, Some(false));
    }
}
