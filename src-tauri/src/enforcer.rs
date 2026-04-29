// In-process enforcement loop for the browser-extension backend.
//
// Every `TICK` seconds, scan each supported browser's default profile.
// If a browser is running but its scan fails (missing / disabled / not
// allowed in private browsing), start a grace countdown, emit events
// the UI turns into a persistent toast + "Fix now" deep-link, and
// quit the browser if the grace expires without the user fixing it.
//
// Originally ported from the MVP enforcer prototype (see git history
// for browser-ext-mvp/enforcer/enforce.mjs).

use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
#[cfg(target_os = "windows")]
use tauri_plugin_notification::NotificationExt;

use crate::profile_scan::{self, BrowserStatus, ProfileStatus};

const TICK: Duration = Duration::from_secs(5);
const HARD_KILL_AFTER: Duration = Duration::from_secs(10);

// User-configurable grace period before a non-compliant browser is
// quit. Read from settings.extensionGraceSeconds on every grace-start
// so changes take effect on the *next* timer (active timers keep
// their original deadline). Defaults to 60s; clamped to a sane range
// so a typo can't disable enforcement entirely or starve the user
// of any chance to fix things.
const GRACE_DEFAULT_SECS: u64 = 60;
pub const GRACE_MIN_SECS: u64 = 5;
pub const GRACE_MAX_SECS: u64 = 300;

fn current_grace(app: &AppHandle) -> Duration {
    let secs = crate::commands::canonical_data_path(app)
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("settings")
                .and_then(|s| s.get("extensionGraceSeconds"))
                .and_then(|n| n.as_u64())
        })
        .unwrap_or(GRACE_DEFAULT_SECS)
        .clamp(GRACE_MIN_SECS, GRACE_MAX_SECS);
    Duration::from_secs(secs)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum BrowserKey {
    Firefox,
    Chrome,
    Brave,
    Edge,
    Safari,
}

impl BrowserKey {
    fn label(self) -> &'static str {
        match self {
            BrowserKey::Firefox => "Firefox",
            BrowserKey::Chrome => "Chrome",
            BrowserKey::Brave => "Brave",
            BrowserKey::Edge => "Edge",
            BrowserKey::Safari => "Safari",
        }
    }

    /// Process name as reported by sysinfo. Exact match on Windows
    /// (with extension), suffix match on macOS (bundle binary).
    fn process_names(self) -> &'static [&'static str] {
        #[cfg(target_os = "windows")]
        match self {
            BrowserKey::Firefox => &["firefox.exe"],
            BrowserKey::Chrome => &["chrome.exe"],
            BrowserKey::Brave => &["brave.exe"],
            BrowserKey::Edge => &["msedge.exe"],
            BrowserKey::Safari => &[],
        }
        #[cfg(target_os = "macos")]
        match self {
            BrowserKey::Firefox => &["firefox"],
            BrowserKey::Chrome => &["Google Chrome"],
            BrowserKey::Brave => &["Brave Browser"],
            BrowserKey::Edge => &["Microsoft Edge"],
            BrowserKey::Safari => &["Safari"],
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        match self {
            _ => &[],
        }
    }

    fn all() -> [BrowserKey; 5] {
        [
            BrowserKey::Firefox,
            BrowserKey::Chrome,
            BrowserKey::Brave,
            BrowserKey::Edge,
            BrowserKey::Safari,
        ]
    }

    fn for_status<'a>(self, r: &'a profile_scan::ScanResult) -> &'a BrowserStatus {
        match self {
            BrowserKey::Firefox => &r.firefox,
            BrowserKey::Chrome => &r.chrome,
            BrowserKey::Brave => &r.brave,
            BrowserKey::Edge => &r.edge,
            BrowserKey::Safari => &r.safari,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionIssue {
    Missing,
    Disabled,
    Private,
    Access,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraceEvent {
    pub browser: BrowserKey,
    pub label: &'static str,
    pub remaining_secs: u64,
    pub total_secs: u64,
    pub issue: ExtensionIssue,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedEvent {
    pub browser: BrowserKey,
    pub label: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClosedEvent {
    pub browser: BrowserKey,
    pub label: &'static str,
    pub issue: ExtensionIssue,
}

#[derive(Debug)]
struct TimerState {
    deadline: Instant,
    total: Duration,
    offense_count: u32,
    issue: ExtensionIssue,
    alert_pid: Option<u32>,
}

#[derive(Default)]
struct EnforcerState {
    timers: HashMap<BrowserKey, TimerState>,
    offenses: HashMap<BrowserKey, u32>,
    enabled: bool,
}

/// Handle returned from `start`. Drop it to stop the loop.
pub struct EnforcerHandle {
    state: Arc<Mutex<EnforcerState>>,
}

impl EnforcerHandle {
    pub fn set_enabled(&self, enabled: bool) {
        if let Ok(mut s) = self.state.lock() {
            s.enabled = enabled;
            if !enabled {
                s.timers.clear();
            }
        }
    }
}

/// Spawn the enforcer loop. Emits `enforcer://grace-update` and
/// `enforcer://grace-resolved` events the UI can subscribe to.
pub fn start(app: AppHandle) -> EnforcerHandle {
    let state = Arc::new(Mutex::new(EnforcerState::default()));
    let state_clone = state.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let enabled = state_clone.lock().map(|s| s.enabled).unwrap_or(false);
        if !enabled {
            continue;
        }
        tick(&app, &state_clone);
    });
    EnforcerHandle { state }
}

fn tick(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>) {
    let scan_result = profile_scan::scan();
    let running = running_browsers();

    for key in BrowserKey::all() {
        let browser_status = key.for_status(&scan_result);
        let is_running = running.contains(&key);

        if !is_running {
            cancel_timer(app, state, key, false);
            continue;
        }

        if default_profile_passes(browser_status) {
            if !cancel_timer(app, state, key, true) {
                emit_resolved(app, key);
            }
            continue;
        }

        let issue = default_profile_issue(browser_status);

        // Failing. Either start a timer or check if it expired.
        let (expired, fresh) = {
            let mut s = match state.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if let Some(t) = s.timers.get_mut(&key) {
                let expired = Instant::now() >= t.deadline;
                if !expired && t.issue != issue {
                    close_system_action_alert(t.alert_pid);
                    let remaining = t.deadline.saturating_duration_since(Instant::now());
                    t.alert_pid = show_system_action_alert(key, issue, remaining.as_secs().max(1));
                    t.issue = issue;
                }
                (expired, false)
            } else {
                let offenses = {
                    let c = s.offenses.entry(key).and_modify(|c| *c += 1).or_insert(1);
                    *c
                };
                // Single user-configured grace for both first and
                // repeat offenses. The previous "30s for repeats"
                // distinction was anti-user once the grace became
                // configurable — a 5s setting still gave 5s on
                // repeats, a 300s setting still gave 300s.
                let grace = current_grace(app);
                let alert_pid = show_system_action_alert(key, issue, grace.as_secs());
                s.timers.insert(
                    key,
                    TimerState {
                        deadline: Instant::now() + grace,
                        total: grace,
                        offense_count: offenses,
                        issue,
                        alert_pid,
                    },
                );
                (false, true)
            }
        };

        if fresh {
            emit_update(app, state, key, browser_status);
            notify_grace_started(app, key, issue);
            continue;
        }

        if expired {
            // Pop the timer before killing so a concurrent tick doesn't
            // re-enter this branch.
            if let Ok(mut s) = state.lock() {
                if let Some(timer) = s.timers.remove(&key) {
                    close_system_action_alert(timer.alert_pid);
                }
            }
            quit_browser(key);
            emit_closed(app, key, issue);
            notify_killed(app, key);
            crate::commands::reveal_app(app);
        } else {
            emit_update(app, state, key, browser_status);
        }
    }
}

fn default_profile_passes(b: &BrowserStatus) -> bool {
    if !b.present {
        return true; // Nothing to check.
    }
    let def: Option<&ProfileStatus> = b
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| b.profiles.first());
    match def {
        Some(p) => p.installed && p.enabled == Some(true) && p.private_browsing == Some(true),
        None => false,
    }
}

fn default_profile_issue(b: &BrowserStatus) -> ExtensionIssue {
    if !b.present {
        return ExtensionIssue::Unknown;
    }
    let def: Option<&ProfileStatus> = b
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| b.profiles.first());
    let Some(p) = def else {
        return ExtensionIssue::Missing;
    };
    if p.note
        .as_deref()
        .map(|note| note.contains("Full Disk Access") || note.contains("Permission"))
        .unwrap_or(false)
    {
        return ExtensionIssue::Access;
    }
    if !p.installed {
        return ExtensionIssue::Missing;
    }
    if p.enabled == Some(false) {
        return ExtensionIssue::Disabled;
    }
    if p.private_browsing != Some(true) {
        return ExtensionIssue::Private;
    }
    ExtensionIssue::Unknown
}

fn cancel_timer(
    app: &AppHandle,
    state: &Arc<Mutex<EnforcerState>>,
    key: BrowserKey,
    emit: bool,
) -> bool {
    let removed = state
        .lock()
        .map(|mut s| s.timers.remove(&key))
        .unwrap_or(None);
    let was_removed = removed.is_some();
    if let Some(timer) = removed {
        close_system_action_alert(timer.alert_pid);
    }
    if was_removed && emit {
        emit_resolved(app, key);
    }
    was_removed
}

fn emit_resolved(app: &AppHandle, key: BrowserKey) {
    let _ = app.emit(
        "enforcer://grace-resolved",
        ResolvedEvent {
            browser: key,
            label: key.label(),
        },
    );
}

fn emit_update(
    app: &AppHandle,
    state: &Arc<Mutex<EnforcerState>>,
    key: BrowserKey,
    browser_status: &BrowserStatus,
) {
    let pair = state.lock().ok().and_then(|s| {
        s.timers.get(&key).map(|t| {
            let remaining = t.deadline.saturating_duration_since(Instant::now());
            (remaining, t.total)
        })
    });
    let (remaining, total) = match pair {
        Some(p) => p,
        None => return,
    };
    let _ = app.emit(
        "enforcer://grace-update",
        GraceEvent {
            browser: key,
            label: key.label(),
            remaining_secs: remaining.as_secs(),
            total_secs: total.as_secs(),
            issue: default_profile_issue(browser_status),
        },
    );
}

fn emit_closed(app: &AppHandle, key: BrowserKey, issue: ExtensionIssue) {
    let _ = app.emit(
        "enforcer://browser-closed",
        ClosedEvent {
            browser: key,
            label: key.label(),
            issue,
        },
    );
}

fn notify_grace_started(app: &AppHandle, key: BrowserKey, issue: ExtensionIssue) {
    let secs = current_grace(app).as_secs();
    let issue_sentence = issue_sentence(key, issue);
    #[cfg(target_os = "macos")]
    let _ = (app, key, issue_sentence, secs);
    #[cfg(not(target_os = "macos"))]
    notify(
        app,
        "ReDD Block: action required",
        &format!(
            "{} Fix it within {}s or {} will be closed.",
            issue_sentence,
            secs,
            key.label()
        ),
    );
}

fn notify_killed(app: &AppHandle, key: BrowserKey) {
    let body = format!(
        "{} was closed because the ReDD Focus extension was missing, turned off, or not allowed in private/incognito windows.",
        key.label()
    );
    #[cfg(target_os = "macos")]
    let _ = app;
    #[cfg(target_os = "macos")]
    show_system_killed_alert(key, &body);
    #[cfg(not(target_os = "macos"))]
    notify(
        app,
        "ReDD Block: browser closed",
        &body,
    );
}

#[cfg(target_os = "windows")]
fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log::warn!("notification failed: {e}");
    } else {
        log::info!("notification: {title} - {body}");
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn notify(_app: &AppHandle, _title: &str, _body: &str) {}

fn issue_description(issue: ExtensionIssue) -> &'static str {
    match issue {
        ExtensionIssue::Missing => "is not installed",
        ExtensionIssue::Disabled => "is turned off",
        ExtensionIssue::Private => "is not allowed in private/incognito windows",
        ExtensionIssue::Access => "cannot be verified",
        ExtensionIssue::Unknown => "is not ready",
    }
}

fn issue_sentence(key: BrowserKey, issue: ExtensionIssue) -> String {
    match issue {
        ExtensionIssue::Private if key == BrowserKey::Chrome => {
            "In Chrome, the ReDD Focus extension is currently not allowed in private/incognito windows.".to_string()
        }
        ExtensionIssue::Private => format!(
            "In {}, the ReDD Focus extension is currently not allowed in private/incognito windows.",
            key.label()
        ),
        _ => format!("ReDD Focus {} in {}.", issue_description(issue), key.label()),
    }
}

fn fix_button_label(key: BrowserKey, issue: ExtensionIssue) -> String {
    match issue {
        ExtensionIssue::Missing => "Install ReDD Focus".to_string(),
        ExtensionIssue::Access if key == BrowserKey::Safari => "Open Full Disk Access".to_string(),
        _ => format!("Open {} Extensions", key.label()),
    }
}

#[cfg(target_os = "macos")]
fn show_system_action_alert(key: BrowserKey, issue: ExtensionIssue, secs: u64) -> Option<u32> {
    let body = if key == BrowserKey::Chrome && issue == ExtensionIssue::Private {
        format!(
            "{}\n\nFix it within {} seconds or {} will be closed.\n\nIn Chrome, find ReDD Focus, then click Details > Allow in Incognito.",
            issue_sentence(key, issue),
            secs,
            key.label()
        )
    } else {
        format!(
            "{}\n\nFix it within {} seconds or {} will be closed.",
            issue_sentence(key, issue),
            secs,
            key.label()
        )
    };
    let fix_label = fix_button_label(key, issue);
    let script = format!(
        r#"beep 2
tell application "System Events" to activate
display alert "ReDD Block: action required" message {} as critical buttons {{"Later", {}}} default button {} cancel button "Later" giving up after {}"#,
        applescript_string(&body),
        applescript_string(&fix_label),
        applescript_string(&fix_label),
        secs.max(1)
    );

    let child = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let child = match child {
        Ok(child) => child,
        Err(e) => {
            log::warn!("system action alert spawn failed: {e}");
            return None;
        }
    };
    let pid = child.id();

    std::thread::spawn(move || {
        match child.wait_with_output() {
            Ok(out) if String::from_utf8_lossy(&out.stdout).contains(&fix_label) => {
                if let Err(e) = open_fix_target(key, issue) {
                    log::warn!("open fix target failed: {e}");
                }
            }
            Ok(out) if !out.status.success() => {
                log::warn!(
                    "system action alert failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Err(e) => log::warn!("system action alert wait failed: {e}"),
            _ => {}
        }
    });
    Some(pid)
}

#[cfg(target_os = "windows")]
fn show_system_action_alert(key: BrowserKey, issue: ExtensionIssue, secs: u64) -> Option<u32> {
    // Windows toast notifications are already system-level; keep the
    // modal path macOS-only until we add a proper Win32 action dialog.
    let _ = (key, issue, secs);
    None
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn show_system_action_alert(_key: BrowserKey, _issue: ExtensionIssue, _secs: u64) -> Option<u32> {
    None
}

#[cfg(target_os = "macos")]
fn close_system_action_alert(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("/bin/kill")
            .arg(pid.to_string())
            .output();
    }
}

#[cfg(not(target_os = "macos"))]
fn close_system_action_alert(_pid: Option<u32>) {}

#[cfg(target_os = "macos")]
fn show_system_killed_alert(key: BrowserKey, body: &str) {
    let script = format!(
        r#"tell application "System Events" to activate
display alert "ReDD Block: browser closed" message {} as informational buttons {{"OK"}} default button "OK""#,
        applescript_string(body)
    );
    let child = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let child = match child {
        Ok(child) => child,
        Err(e) => {
            log::warn!("system killed alert spawn failed for {}: {e}", key.label());
            return;
        }
    };

    std::thread::spawn(move || match child.wait_with_output() {
        Ok(out) if !out.status.success() => {
            log::warn!(
                "system killed alert failed for {}: {}",
                key.label(),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Err(e) => log::warn!("system killed alert wait failed for {}: {e}", key.label()),
        _ => {}
    });
}

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    format!("{:?}", value)
}

#[cfg(target_os = "macos")]
fn open_fix_target(key: BrowserKey, issue: ExtensionIssue) -> Result<(), String> {
    if matches!(issue, ExtensionIssue::Missing) {
        let url = match key {
            BrowserKey::Firefox => "https://addons.mozilla.org/en-US/firefox/addon/reddfocus/",
            BrowserKey::Safari => "https://apps.apple.com/us/app/redd-focus-hide-distractions/id1660218371",
            _ => "https://chromewebstore.google.com/detail/redd-focus-hide-distracti/hhblkhfdjijdinijakbmcpkmdfhoadcd",
        };
        let out = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .output()
            .map_err(|e| format!("spawn /usr/bin/open: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "open store URL exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        return Ok(());
    }

    if matches!((key, issue), (BrowserKey::Safari, ExtensionIssue::Access)) {
        return crate::commands::open_safari_fda_settings();
    }

    crate::commands::open_browser_extension_settings(key.label().to_string())
}

// ---- Process detection + quit -----------------------------------------

fn running_browsers() -> std::collections::HashSet<BrowserKey> {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut out = std::collections::HashSet::new();
    for key in BrowserKey::all() {
        for name in key.process_names() {
            let lowered = name.to_ascii_lowercase();
            if sys.processes().values().any(|p| {
                p.name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(&lowered)
            }) {
                out.insert(key);
                break;
            }
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn quit_browser(key: BrowserKey) {
    // SIGTERM all matching processes so browsers can persist
    // session/cookies, then wait until the process is actually gone
    // before reporting closure. If it is still alive after
    // HARD_KILL_AFTER, escalate to SIGKILL. Same primitive as the app
    // watcher — no AppleScript and no Automation TCC dependency.
    use sysinfo::{ProcessesToUpdate, Signal, System};

    fn matches_browser(key: BrowserKey, name: &str) -> bool {
        let names = key.process_names();
        let lower = name.to_ascii_lowercase();
        names
            .iter()
            .any(|n| lower.ends_with(&n.to_ascii_lowercase()))
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for proc_ in sys.processes().values() {
        let name = proc_.name().to_string_lossy().to_string();
        if !matches_browser(key, &name) {
            continue;
        }
        if let Some(false) = proc_.kill_with(Signal::Term) {
            log::warn!(
                "enforcer: SIGTERM failed for pid={} name='{}'",
                proc_.pid(),
                name
            );
        }
    }

    let browser_still_running = |sys: &mut System| -> bool {
        sys.refresh_processes(ProcessesToUpdate::All, true);
        sys.processes().values().any(|proc_| {
            let name = proc_.name().to_string_lossy().to_string();
            matches_browser(key, &name)
        })
    };

    let deadline = Instant::now() + HARD_KILL_AFTER;
    let mut sys = System::new();
    while Instant::now() < deadline {
        if !browser_still_running(&mut sys) {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for proc_ in sys.processes().values() {
        let name = proc_.name().to_string_lossy().to_string();
        if !matches_browser(key, &name) {
            continue;
        }
        log::info!("enforcer: SIGKILL pid={} name='{}'", proc_.pid(), name);
        if !proc_.kill() {
            log::warn!(
                "enforcer: SIGKILL failed for pid={} name='{}'",
                proc_.pid(),
                name
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn quit_browser(key: BrowserKey) {
    // Windows has no SIGTERM. The closest graceful primitive is
    // posting WM_CLOSE to the browser's top-level window — that's
    // what `taskkill` (no /F) does, which lets Chromium run its
    // normal exit path and persist session/cookies. After
    // HARD_KILL_AFTER we escalate to forced termination on the whole
    // process tree.
    use std::process::Command;

    for name in key.process_names() {
        log::info!("enforcer: requesting graceful close of {name} (taskkill /T)");
        match Command::new("taskkill").args(["/IM", name, "/T"]).output() {
            Ok(out) => log::debug!(
                "enforcer: taskkill /IM {name} /T -> exit {:?}",
                out.status.code()
            ),
            Err(e) => log::warn!("enforcer: taskkill /IM {name} /T spawn failed: {e}"),
        }
    }

    std::thread::sleep(HARD_KILL_AFTER);

    for name in key.process_names() {
        log::info!("enforcer: forcing close of {name} (taskkill /F /T)");
        if let Err(e) = Command::new("taskkill")
            .args(["/F", "/IM", name, "/T"])
            .output()
        {
            log::warn!("enforcer: taskkill /F /IM {name} /T spawn failed: {e}");
        }
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn quit_browser(_key: BrowserKey) {
    // No enforcer support on Linux yet.
}
