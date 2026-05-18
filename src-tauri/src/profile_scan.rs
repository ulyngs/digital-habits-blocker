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

// ReDD Focus extension IDs. Keep in sync with the MVP script.
const FIREFOX_ID: &str = "mindshield@example.com";
const CHROMIUM_ID: &str = "hhblkhfdjijdinijakbmcpkmdfhoadcd";
#[cfg(target_os = "macos")]
const SAFARI_EXTENSION_KEYS: &[&str] = &[
    // Embedded inside this ReDD Block.app — the bundled Safari Web
    // Extension target from redd-focus-web/, signed under our team.
    // This is the path most users will hit going forward, since
    // installing ReDD Block automatically lights up the extension
    // in Safari without any separate App-Store install.
    "com.reddblock.SafariExtension (JD647S9RT6)",
    // Legacy: standalone "ReDD Focus" macOS app from the App Store.
    // Still recognised so users who installed it before we bundled
    // don't see a regression. The two installs can coexist; Safari
    // shows them as two separate listings under Settings → Extensions
    // and the scanner accepts either as "ReDD Focus is here".
    "com.ulriklyngs.mind-shield.mind-shield (JD647S9RT6)",
];

/// Chromium IDs the scanner will accept as "ReDD Focus is here".
/// Production ID is always included. In debug builds, comma-separated
/// IDs from `REDD_DEV_EXT_ID` are appended so an unpacked dev extension
/// (path-derived ID, ≠ production) is recognised by the compliance
/// scan. The env var is ignored in release builds.
fn chromium_ids() -> Vec<String> {
    let mut ids = vec![CHROMIUM_ID.to_string()];
    if cfg!(debug_assertions) {
        if let Ok(extra) = std::env::var("REDD_DEV_EXT_ID") {
            for id in extra.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                ids.push(id.to_string());
            }
        }
    }
    ids
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Scan only the browsers for which `should_scan` returns true; the
/// rest are returned as empty stubs (`installed=false, present=false,
/// profiles=[]`).
///
/// Why this exists: the underlying scan reads each browser's
/// `~/Library/Application Support/<vendor>/...` data files. On
/// macOS Sequoia 15+ that triggers a per-app "ReDD Block would like
/// to access data from other apps" TCC prompt for *each* browser
/// data folder we touch — so a user with Chrome + Brave + Edge +
/// Firefox installed gets four serial prompts on a single tick. The
/// enforcer only ever takes action on *running* browsers, so it
/// passes a predicate that filters to those, dropping prompts (and
/// I/O cost) for browsers that aren't currently open.
///
/// The vendor labels passed to the predicate are the lowercase
/// short names: "firefox", "chrome", "brave", "edge", "safari".
pub fn scan_filter<F: Fn(&str) -> bool>(_should_scan: F) -> ScanResult {
    // EXPERIMENT (branch: experiment/stub-profile-scan): all real scan
    // bodies disabled. We're testing whether the recurring macOS TCC
    // "would like to access data from other apps" prompt is triggered
    // by these per-tick reads of other browsers' Application Support
    // dirs (Chrome/Brave/Edge Preferences, Firefox extensions.json,
    // Safari plist/pluginkit). Reverting this restores the real scans.
    log::warn!("profile_scan::scan_filter stubbed for TCC experiment — returning empty");
    ScanResult {
        firefox: empty("firefox"),
        chrome: empty("chrome"),
        brave: empty("brave"),
        edge: empty("edge"),
        safari: empty("safari"),
    }
}

fn empty(_label: &str) -> BrowserStatus {
    BrowserStatus {
        present: false,
        installed: false,
        profiles: vec![],
        error: None,
    }
}

// ---- Firefox ---------------------------------------------------------------

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
fn firefox_app_installed() -> bool {
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
                        s.installed = true;
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
                        s.enabled = Some(active && !user_disabled && !app_disabled);
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

    let line = prefs_js.lines().find(|line| line.trim_start().starts_with(KEY))?;
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
    Some(dirs::home_dir()?.join(
        "Library/Containers/com.apple.Safari/Data/Library/Safari/Profiles",
    ))
}

/// True when this ReDD Block.app has the bundled Safari Web
/// Extension `.appex` in its `Contents/PlugIns/` — i.e. when the
/// build pipeline that runs scripts/embed-safari-extension.sh has
/// taken effect for this binary.
///
/// We use this to short-circuit the plist-based "is the extension
/// installed?" check on every Safari profile: if the host app
/// embeds the extension, it's structurally guaranteed to be there
/// regardless of FDA, regardless of whether Safari has written its
/// `WebExtensions/Extensions.plist` entry yet, and regardless of
/// whether the user has actively enabled it. State checks (enabled
/// / private-browsing / all-websites) still come from the plist,
/// because Safari is the source of truth for those.
#[cfg(target_os = "macos")]
fn embedded_safari_extension_present() -> bool {
    // current_exe() resolves to .../ReDD Block.app/Contents/MacOS/redd-block.
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
fn safari_extensions_plist_paths() -> (
    Vec<(String, bool, PathBuf)>,
    Option<SafariPlistScanError>,
) {
    let mut paths = Vec::new();
    if let Some(path) = safari_extensions_plist_path() {
        paths.push(("(Default Safari profile)".to_string(), true, path));
    }

    let Some(profiles_dir) = safari_profiles_dir() else {
        return (paths, None);
    };
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
    let bytes = std::fs::read(path).map_err(|e| safari_plist_io_error(e))?;
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
    let running = is_process_running(&["Safari"]);
    let mut profiles = Vec::new();
    let mut error = None;
    let embedded = embedded_safari_extension_present();

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

    if profiles.is_empty() {
        let note = SafariPlistScanError::Missing.note();
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

    // If the bundled Safari Web Extension lives inside this very
    // .app, force `installed=true` on every profile entry — the
    // plist-based check would otherwise miss it whenever the user
    // hasn't granted Full Disk Access (the FDA branch already wrote
    // installed=false above) or whenever Safari hasn't flushed its
    // Extensions.plist entry yet (fresh install before the user
    // visits Settings → Extensions). Enabled / private / all-sites
    // state remain plist-driven; we don't synthesise them here
    // because Safari is the source of truth and the user can
    // legitimately have the extension toggled off. Once we wire up
    // SFSafariExtensionManager (Phase 4), even those state fields
    // become independent of FDA.
    if embedded {
        for profile in profiles.iter_mut() {
            if profile.installed {
                continue;
            }
            profile.installed = true;
            // Plist read failed (no FDA, missing file, etc.) and the
            // existing handler stamped `Some(false)` on each state
            // field as a placeholder. Now that we know the extension
            // IS installed, demote those to None — "unknown" is more
            // accurate than "definitely off".
            if profile.note.is_some() {
                profile.enabled = None;
                profile.private_browsing = None;
                profile.website_access_all = None;
            }
        }
        // Drop the top-level error if the only thing it was
        // reporting was an FDA-style plist failure — we no longer
        // need FDA to know the extension is there. Per-profile
        // notes stay so the UI can still surface "FDA needed for
        // enabled-state details" if it cares.
        error = None;

        // Ask SafariServices for the live `enabled` state via the
        // Swift bridge. Bypasses the FDA-protected plist entirely
        // for this one field. Bridge only succeeds when called from
        // the registered main executable of the host bundle (i.e.
        // the bundled `.app`); during `cargo tauri dev` it returns
        // `extensionNotFound`, in which case we leave whatever the
        // plist scan already reported (or None if FDA was missing).
        // SafariServices doesn't expose private-browsing or per-site
        // permission state at all — those still come from the plist.
        match crate::safari_services::extension_state(
            crate::native_host_install::SAFARI_EXT_ID,
        ) {
            Ok(state) => {
                for profile in profiles.iter_mut() {
                    profile.enabled = Some(state.enabled);
                    // If the plist couldn't be read, the bridge gave
                    // us a definitive `enabled` answer that supersedes
                    // the "FDA needed" note for that one field. Keep
                    // the note around for private-browsing and
                    // all-sites, which the bridge can't introspect.
                }
                log::debug!(
                    "safari: bridge reports enabled={}",
                    state.enabled
                );
            }
            Err(e) => {
                log::debug!(
                    "safari: bridge state query failed (expected outside .app): {e}"
                );
            }
        }

        // The Safari Web Extension reports its own incognito-access
        // state into the App Group container on every periodic refresh.
        // SafariServices can't introspect this field, so this self-
        // report is our FDA-free source of truth. If we have a fresh
        // value, overlay it on profiles whose private-browsing is
        // currently unknown (None) so the enforcer and onboarding UI
        // see accurate state. A stale or missing file leaves the
        // existing None behaviour intact.
        if let Some(private_browsing) = safari_extension_self_reported_private_browsing() {
            for profile in profiles.iter_mut() {
                if profile.private_browsing.is_none() {
                    profile.private_browsing = Some(private_browsing);
                }
            }
            log::debug!(
                "safari: extension self-reports privateBrowsing={}",
                private_browsing
            );
        }
    }

    BrowserStatus {
        present: running,
        installed: true,
        profiles,
        error,
    }
}

/// Read the extension's self-reported state from the App Group
/// container. The Safari Web Extension writes
/// `safari-extension-state.json` on every periodic refresh
/// (`SafariWebExtensionHandler.persistExtensionState`). Returns the
/// reported `privateBrowsing` value when the file is present and fresh,
/// `None` when missing, malformed, or older than the staleness window.
///
/// Staleness window is 5 minutes. The extension refreshes every 15 s
/// while Safari is running, so anything older than that means Safari
/// hasn't been running recently (or the extension is broken) — in
/// either case we'd rather return None and let the enforcer's leniency
/// path kick in than serve a half-day-old reading as truth.
#[cfg(target_os = "macos")]
fn safari_extension_self_reported_private_browsing() -> Option<bool> {
    const FRESHNESS_MS: u64 = 5 * 60 * 1000;

    let home = dirs::home_dir()?;
    let path = home
        .join("Library")
        .join("Group Containers")
        .join("group.com.reddblock.shared")
        .join("safari-extension-state.json");
    let bytes = std::fs::read(&path).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;

    let reported_at = v.get("reportedAtMs").and_then(|x| x.as_u64()).unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    if now_ms.saturating_sub(reported_at) > FRESHNESS_MS {
        return None;
    }
    v.get("privateBrowsing").and_then(|x| x.as_bool())
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
    }
}

/// True if every running-and-present Chromium/Firefox browser has a
/// compliant default profile. Safari is stricter: every Safari profile
/// plist we can see must report installed+enabled+privateBrowsing and
/// all-website access. Used by onboarding to gate the backend switch.
///
pub fn compliant(result: &ScanResult) -> bool {
    let chromium_or_firefox = [&result.firefox, &result.chrome, &result.brave, &result.edge];
    let chromium_ok = chromium_or_firefox.iter().all(|b| {
        !b.present || {
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
    });
    let safari_ok = !result.safari.present
        || (!result.safari.profiles.is_empty()
            && result
                .safari
                .profiles
                .iter()
                .all(|p| safari_profile_passes(p)));
    chromium_ok && safari_ok
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
