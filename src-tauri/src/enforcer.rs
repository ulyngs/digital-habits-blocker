// In-process enforcement loop for the browser-extension backend.
//
// Every `TICK` seconds, *if any website-blocking is currently active*
// (`website_blocking_active`), scan each supported browser's default
// profile. If a browser is running but its scan fails (missing /
// disabled / not allowed in private browsing), start a grace
// countdown, emit events the UI turns into a persistent toast +
// "Fix now" deep-link, and quit the browser if the grace expires
// without the user fixing it.
//
// When no website-blocking is active the tick is a no-op (and any
// in-flight grace timer is resolved). The extension is only
// load-bearing during a block, so we deliberately don't pester
// users about its configuration outside of that.
//
// Originally ported from the MVP enforcer prototype (see git history
// for browser-ext-mvp/enforcer/enforce.mjs).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(any(target_os = "macos", target_os = "windows"))]


use crate::profile_scan::{self, BrowserStatus, ProfileStatus};

const TICK: Duration = Duration::from_secs(5);
const TICK_FAST: Duration = Duration::from_secs(1);
const HARD_KILL_AFTER: Duration = Duration::from_secs(10);

/// True if any block is currently being enforced through the browser
/// extension (one-off block in its window, or a schedule segment
/// active right now). Reads the canonical app-data file directly so
/// the enforcer doesn't need a separate IPC channel — the native-host
/// payload derivation is the single source of truth for "what's
/// blocking right now", so we reuse it.
///
/// Returns false when:
///   - the data file is missing or unreadable,
///   - no website-blocking is currently active (only app-blocking, or
///     nothing at all, or schedules outside their active window),
///   - all active blocks are paused.
///
/// This gates the entire enforcement tick. When false we don't quit
/// browsers, don't start grace timers, and clear any in-flight ones —
/// the browser extension is irrelevant when nothing browser-related
/// is being enforced, so a misconfigured extension is the user's
/// problem to discover when they next start a block, not ours to
/// police pre-emptively.
fn website_blocking_active(app: &AppHandle) -> bool {
    let path = match crate::commands::canonical_data_path(app) {
        Some(p) => p,
        None => return false,
    };
    let (domains, _blocks) = crate::native_host::derive_payload(&path);
    !domains.is_empty()
}

/// True if the user has explicitly opted in to browser enforcement
/// (force-closing non-compliant browsers during active blocks).
/// Defaults to `false` so new users aren't surprised by automatic
/// browser force-closes. The user toggles this in the extension
/// setup dialog.
fn enforcement_enabled(app: &AppHandle) -> bool {
    let path = match crate::commands::canonical_data_path(app) {
        Some(p) => p,
        None => return false,
    };
    let data: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null);
    data.get("settings")
        .and_then(|s| s.get("enforcementEnabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

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

    /// Browsers the in-process enforcer polices on this platform. All of
    /// them on both macOS and Windows — but the *compliance signal*
    /// differs (see `compliance_issue`): on macOS, Safari + Chromium are
    /// judged by their Automation (Apple Events) permission instead of
    /// the extension scan (they moved to web_automation.rs), while
    /// Firefox stays on the extension. Windows keeps every browser on the
    /// extension scan. Either way a failing browser rides the same
    /// grace-timer + force-quit path.
    fn enforced() -> &'static [BrowserKey] {
        &[
            BrowserKey::Firefox,
            BrowserKey::Chrome,
            BrowserKey::Brave,
            BrowserKey::Edge,
            BrowserKey::Safari,
        ]
    }

    /// macOS only: map to the web_automation browser enum for the
    /// Automation-permission check. Firefox has no mapping (it stays on
    /// the extension path).
    #[cfg(target_os = "macos")]
    fn to_web_automation(self) -> Option<crate::web_automation::SupportedBrowser> {
        use crate::web_automation::SupportedBrowser as S;
        match self {
            BrowserKey::Chrome => Some(S::Chrome),
            BrowserKey::Brave => Some(S::Brave),
            BrowserKey::Edge => Some(S::Edge),
            BrowserKey::Safari => Some(S::Safari),
            BrowserKey::Firefox => None,
        }
    }

    /// Short settings key (`chrome`, `brave`, …).
    fn setting_key(self) -> &'static str {
        match self {
            BrowserKey::Firefox => "firefox",
            BrowserKey::Chrome => "chrome",
            BrowserKey::Brave => "brave",
            BrowserKey::Edge => "edge",
            BrowserKey::Safari => "safari",
        }
    }

    /// macOS: true when this browser is blocked via Automation (not extension).
    #[cfg(target_os = "macos")]
    fn uses_automation_on_macos(self, app: &AppHandle) -> bool {
        crate::blocking_method::uses_automation(app, self.setting_key())
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

/// What's wrong with the extension in this browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionIssue {
    Missing,
    Disabled,
    Private,
    /// Safari: not allowed on all websites.
    WebsiteAccess,
    /// Can't read extension state (e.g. Full Disk Access needed for Safari).
    Access,
    /// macOS Safari/Chromium: the Automation (Apple Events) permission this
    /// build uses to redirect tabs is denied. Fix = re-enable the browser
    /// under System Settings → Privacy & Security → Automation. Not an
    /// extension problem — these browsers no longer use the extension on
    /// macOS — but it rides the same grace/force-close machinery.
    Automation,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraceEvent {
    pub browser: BrowserKey,
    pub label: &'static str,
    pub remaining_secs: u64,
    pub total_secs: u64,
    pub issue: ExtensionIssue,
    /// Grace expired and we are waiting for the browser process to exit.
    pub closing: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedEvent {
    pub browser: BrowserKey,
    pub label: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserClosedEvent {
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
}

/// A browser whose grace expired and we are waiting for its process to
/// disappear. `quit_dispatched` distinguishes a user manual quit
/// (gone before we asked) from a force-close we initiated.
#[derive(Debug)]
struct ClosingState {
    issue: ExtensionIssue,
    quit_dispatched: bool,
    quit_started: Instant,
}

#[derive(Default)]
struct EnforcerState {
    timers: HashMap<BrowserKey, TimerState>,
    closing: HashMap<BrowserKey, ClosingState>,
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
                s.closing.clear();
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
        let fast = state_clone
            .lock()
            .map(|s| !s.timers.is_empty() || !s.closing.is_empty())
            .unwrap_or(false);
        std::thread::sleep(if fast { TICK_FAST } else { TICK });
        let enabled = state_clone.lock().map(|s| s.enabled).unwrap_or(false);
        if !enabled {
            continue;
        }
        tick(&app, &state_clone);
    });
    EnforcerHandle { state }
}

fn tick(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>) {
    // Don't pester users when no website-blocking is currently active.
    // The enforcer exists to make sure the browser extension can do
    // its job during a block — outside of an active block it has
    // nothing to enforce, and force-closing a browser in that state
    // is just hostile (a tester hit exactly this case: the extension
    // wasn't allowed in incognito, no block was running, and Chrome
    // got killed anyway). Resolve any in-flight grace timers so the
    // UI banner clears if a block just expired or got paused mid-grace.
    if !website_blocking_active(app) {
        for &key in BrowserKey::enforced() {
            cancel_timer(app, state, key, true);
            cancel_closing(app, state, key, true);
        }
        return;
    }

    // Don't force-close browsers unless the user has explicitly opted
    // in. Enforcement is powerful but jarring for new users who don't
    // understand why their browser was killed. Default is OFF; the
    // user enables it in the extension setup dialog once they've
    // understood the behaviour.
    if !enforcement_enabled(app) {
        for &key in BrowserKey::enforced() {
            cancel_timer(app, state, key, true);
            cancel_closing(app, state, key, true);
        }
        return;
    }

    // Compute the running set FIRST, then scan only those browsers.
    // Reading a browser's `~/Library/Application Support/<vendor>/...`
    // data triggers macOS Sequoia's per-app data-access TCC prompt;
    // unconditionally scanning all five vendors meant a user with
    // four browsers installed got four serial prompts every tick,
    // even though we only ever act on running browsers. If nothing's
    // running there's nothing to enforce — bail before touching disk.
    let running = running_browsers();
    sweep_closing(app, state, &running);
    if running.is_empty() {
        // User quit every browser (or the last one we were timing) —
        // tell the UI to drop any in-flight grace banner, same as
        // app_watcher's warning-hide on PID gone.
        for &key in BrowserKey::enforced() {
            cancel_timer(app, state, key, true);
        }
        return;
    }

    // Only scan browsers we actually judge by the extension. On macOS
    // that's Firefox alone — scanning a Chromium/Safari profile dir
    // triggers Sequoia's per-app data-access TCC prompt, and we don't
    // need it anyway (those are judged by `query_automation_permission`,
    // which reads the decision without touching disk or prompting).
    let scan_result = profile_scan::scan_filter(|label| {
        let key = match label {
            "firefox" => BrowserKey::Firefox,
            "chrome" => BrowserKey::Chrome,
            "brave" => BrowserKey::Brave,
            "edge" => BrowserKey::Edge,
            "safari" => BrowserKey::Safari,
            _ => return false,
        };
        if !running.contains(&key) {
            return false;
        }
        #[cfg(target_os = "macos")]
        {
            if key.uses_automation_on_macos(app) {
                return matches!(key, BrowserKey::Firefox);
            }
            matches!(
                key,
                BrowserKey::Firefox
                    | BrowserKey::Chrome
                    | BrowserKey::Brave
                    | BrowserKey::Edge
                    | BrowserKey::Safari
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    });

    for &key in BrowserKey::enforced() {
        if state
            .lock()
            .map(|s| s.closing.contains_key(&key))
            .unwrap_or(false)
        {
            continue;
        }

        let is_running = running.contains(&key);

        if !is_running {
            // Browser exited on its own during grace — not a force-close,
            // so emit grace-resolved (not browser-closed).
            cancel_timer(app, state, key, true);
            continue;
        }

        // None = compliant (extension OK, or Automation granted) → clear
        // any timer and move on. Some(issue) = act on it.
        let issue = match compliance_issue(app, key, &scan_result, is_running) {
            None => {
                cancel_timer(app, state, key, true);
                continue;
            }
            Some(i) => i,
        };
        log_non_compliant_summary(key, issue, &scan_result);

        // Failing. Either start a timer or check if it expired.
        let (expired, fresh) = {
            let mut s = match state.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if let Some(t) = s.timers.get(&key) {
                (Instant::now() >= t.deadline, false)
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
                let deadline = Instant::now() + grace;
                s.timers.insert(
                    key,
                    TimerState {
                        deadline,
                        total: grace,
                        offense_count: offenses,
                        issue,
                    },
                );
                // If several browsers become non-compliant during the
                // same active block, treat them as one enforcement moment:
                // the newest grace window becomes the shared close time.
                for timer in s.timers.values_mut() {
                    if timer.deadline < deadline {
                        timer.deadline = deadline;
                        timer.total = grace;
                    }
                }
                (false, true)
            }
        };

        if fresh {
            emit_all_updates(app, state);
            crate::commands::reveal_app(app);
            continue;
        }

        if expired {
            begin_browser_close(app, state, key, issue);
            crate::commands::reveal_app(app);
        } else {
            emit_update(app, state, key);
        }
    }
}

fn begin_browser_close(
    app: &AppHandle,
    state: &Arc<Mutex<EnforcerState>>,
    key: BrowserKey,
    issue: ExtensionIssue,
) {
    let inserted = state
        .lock()
        .ok()
        .map(|mut s| {
            s.timers.remove(&key);
            s.closing
                .insert(
                    key,
                    ClosingState {
                        issue,
                        quit_dispatched: false,
                        quit_started: Instant::now(),
                    },
                )
                .is_none()
        })
        .unwrap_or(false);
    if !inserted {
        return;
    }
    emit_closing(app, key, issue);
    dispatch_browser_quit(key);
    if let Ok(mut s) = state.lock() {
        if let Some(c) = s.closing.get_mut(&key) {
            c.quit_dispatched = true;
        }
    }
}

fn sweep_closing(
    app: &AppHandle,
    state: &Arc<Mutex<EnforcerState>>,
    running: &std::collections::HashSet<BrowserKey>,
) {
    let keys: Vec<BrowserKey> = state
        .lock()
        .ok()
        .map(|s| s.closing.keys().copied().collect())
        .unwrap_or_default();
    for key in keys {
        if running.contains(&key) {
            maybe_escalate_browser_kill(state, key);
            continue;
        }
        finish_browser_close(app, state, key);
    }
}

fn finish_browser_close(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>, key: BrowserKey) {
    let closing = state.lock().ok().and_then(|mut s| s.closing.remove(&key));
    let Some(closing) = closing else {
        return;
    };
    if closing.quit_dispatched {
        emit_browser_closed(app, key, closing.issue);
        crate::commands::reveal_app(app);
    } else {
        emit_grace_resolved(app, key);
    }
}

fn maybe_escalate_browser_kill(state: &Arc<Mutex<EnforcerState>>, key: BrowserKey) {
    let should_kill = state
        .lock()
        .ok()
        .and_then(|s| {
            s.closing.get(&key).map(|c| {
                c.quit_dispatched && c.quit_started.elapsed() >= HARD_KILL_AFTER
            })
        })
        .unwrap_or(false);
    if should_kill {
        force_kill_browser(key);
    }
}

fn log_non_compliant(key: BrowserKey, b: &BrowserStatus) {
    let reasons: Vec<String> = b
        .profiles
        .iter()
        .filter(|p| {
            !(p.installed
                && p.enabled == Some(true)
                // Treat unknown private-browsing as "OK", not as "off" —
                // the bundled Safari extension can't query this field
                // from the host app without Full Disk Access, and the
                // whole point of bundling is to be FDA-free. Only
                // enforce when we positively know it's disabled.
                && p.private_browsing != Some(false)
                && p.website_access_all.unwrap_or(true))
        })
        .map(|p| {
            let mut fields = format!(
                "{} installed={} enabled={:?} private={:?}",
                p.name, p.installed, p.enabled, p.private_browsing
            );
            if let Some(website_access_all) = p.website_access_all {
                fields.push_str(&format!(" websiteAll={website_access_all}"));
            }
            fields
        })
        .collect();
    log::info!(
        "enforcer: {} non-compliant: {}",
        key.label(),
        if reasons.is_empty() {
            "no compliant default profile".to_string()
        } else {
            reasons.join("; ")
        }
    );
}

fn default_profile_passes(b: &BrowserStatus) -> bool {
    // The caller already proved the browser is running via
    // `running_browsers()`. Do not re-check `b.present` here: it is
    // computed by a separate scan, and a transient disagreement would
    // incorrectly let a running, non-compliant browser pass.
    if b.profiles.iter().any(|p| p.website_access_all.is_some()) {
        return !b.profiles.is_empty()
            && b.profiles.iter().all(|p| {
                p.installed
                    && p.enabled == Some(true)
                    && p.private_browsing != Some(false)
                    && p.website_access_all == Some(true)
            });
    }
    let def: Option<&ProfileStatus> = b
        .profiles
        .iter()
        .find(|p| p.is_default)
        .or_else(|| b.profiles.first());
    match def {
        Some(p) => {
            p.installed
                && p.enabled == Some(true)
                // Unknown private-browsing state (None) passes; only
                // a positive Some(false) reading triggers enforcement.
                // The bundled Safari extension legitimately has None
                // here when the user hasn't granted Full Disk Access,
                // and force-closing on unmeasurable state is hostile.
                && p.private_browsing != Some(false)
                && p.website_access_all.unwrap_or(true)
        }
        None => false,
    }
}

fn cancel_timer(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>, key: BrowserKey, emit: bool) {
    let removed = state
        .lock()
        .map(|mut s| s.timers.remove(&key).is_some())
        .unwrap_or(false);
    if removed && emit {
        emit_grace_resolved(app, key);
    }
}

fn cancel_closing(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>, key: BrowserKey, emit: bool) {
    let removed = state
        .lock()
        .map(|mut s| s.closing.remove(&key).is_some())
        .unwrap_or(false);
    if removed && emit {
        emit_grace_resolved(app, key);
    }
}

fn emit_grace_resolved(app: &AppHandle, key: BrowserKey) {
    let _ = app.emit(
        "enforcer://grace-resolved",
        ResolvedEvent {
            browser: key,
            label: key.label(),
        },
    );
}

fn emit_update(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>, key: BrowserKey) {
    let triple = state.lock().ok().and_then(|s| {
        s.timers.get(&key).map(|t| {
            let remaining = t.deadline.saturating_duration_since(Instant::now());
            (remaining, t.total, t.issue)
        })
    });
    let (remaining, total, issue) = match triple {
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
            issue,
            closing: false,
        },
    );
}

fn emit_closing(app: &AppHandle, key: BrowserKey, issue: ExtensionIssue) {
    let _ = app.emit(
        "enforcer://grace-update",
        GraceEvent {
            browser: key,
            label: key.label(),
            remaining_secs: 0,
            total_secs: 0,
            issue,
            closing: true,
        },
    );
}

fn emit_all_updates(app: &AppHandle, state: &Arc<Mutex<EnforcerState>>) {
    for &key in BrowserKey::enforced() {
        emit_update(app, state, key);
    }
}

fn emit_browser_closed(app: &AppHandle, key: BrowserKey, issue: ExtensionIssue) {
    let _ = app.emit(
        "enforcer://browser-closed",
        BrowserClosedEvent {
            browser: key,
            label: key.label(),
            issue,
        },
    );
}

/// Derive the most specific issue from the browser's profile status.
fn diagnose_issue(b: &BrowserStatus) -> ExtensionIssue {
    // For browsers with website_access_all support (Safari), check all profiles.
    if b.profiles.iter().any(|p| p.website_access_all.is_some()) {
        if b.profiles.iter().any(|p| !p.installed) {
            return ExtensionIssue::Missing;
        }
        if b.profiles.iter().any(|p| p.enabled == Some(false) || p.enabled.is_none()) {
            return ExtensionIssue::Disabled;
        }
        if b.profiles.iter().any(|p| p.private_browsing == Some(false)) {
            return ExtensionIssue::Private;
        }
        if b.profiles.iter().any(|p| p.website_access_all != Some(true)) {
            return ExtensionIssue::WebsiteAccess;
        }
        return ExtensionIssue::Unknown;
    }
    // Standard Chromium / Firefox: check the default profile.
    let def = b.profiles.iter().find(|p| p.is_default).or_else(|| b.profiles.first());
    match def {
        Some(p) => {
            if !p.installed { ExtensionIssue::Missing }
            else if p.enabled != Some(true) { ExtensionIssue::Disabled }
            else if p.private_browsing == Some(false) { ExtensionIssue::Private }
            else { ExtensionIssue::Unknown }
        }
        None => {
            // No profiles at all — likely can't read the extension state
            if b.profiles.is_empty() && b.error.is_some() {
                ExtensionIssue::Access
            } else {
                ExtensionIssue::Missing
            }
        }
    }
}

/// Decide whether a *running* enforced browser is currently compliant.
/// `None` = nothing to enforce; `Some(issue)` = start/continue the grace
/// timer toward a force-close.
///
/// macOS Safari/Chromium are judged by Automation permission via the
/// watcher's cached state, a live osascript probe, and the silent TCC
/// read (in that order). Only `Unknown` across all three is treated as
/// compliant — same leniency as before for unmeasurable state. Firefox
/// (all platforms) and every browser on Windows fall back to the
/// extension scan.
fn compliance_issue(
    app: &AppHandle,
    key: BrowserKey,
    scan: &profile_scan::ScanResult,
    is_running: bool,
) -> Option<ExtensionIssue> {
        #[cfg(target_os = "macos")]
        {
            if key.uses_automation_on_macos(app) {
                if let Some(browser) = key.to_web_automation() {
                    let cached = watcher_automation_cache(app, browser);
                    if crate::web_automation::automation_denied_for_enforcement(
                        browser, cached, is_running,
                    ) {
                        return Some(ExtensionIssue::Automation);
                    }
                }
                return None;
            }
        }
    let b = key.for_status(scan);
    #[cfg(target_os = "macos")]
    if key == BrowserKey::Safari && b.needs_fda_access {
        return None;
    }
    if default_profile_passes(b) {
        None
    } else {
        Some(diagnose_issue(b))
    }
}

#[cfg(target_os = "macos")]
fn watcher_automation_cache(
    app: &AppHandle,
    browser: crate::web_automation::SupportedBrowser,
) -> Option<crate::web_automation::PermState> {
    let state = app.try_state::<crate::commands::web_automation::WebAutomationState>()?;
    let guard = state.0.lock().ok()?;
    let handle = guard.as_ref()?;
    handle
        .permission_status()
        .into_iter()
        .find(|i| i.browser == browser)
        .map(|i| i.state)
}

/// Log why a browser is being enforced. Automation denials have no
/// per-profile detail to dump, so keep them terse; extension issues defer
/// to the detailed per-profile dump.
fn log_non_compliant_summary(
    key: BrowserKey,
    issue: ExtensionIssue,
    scan: &profile_scan::ScanResult,
) {
    if issue == ExtensionIssue::Automation {
        log::info!(
            "enforcer: {} non-compliant: Automation permission denied",
            key.label()
        );
        return;
    }
    log_non_compliant(key, key.for_status(scan));
}

// ---- Process detection + quit -----------------------------------------

fn running_browsers() -> std::collections::HashSet<BrowserKey> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    // We only match on process names — skip the default CPU/memory/disk/
    // exe refresh that `refresh_processes` does for every process.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let mut out = std::collections::HashSet::new();
    for &key in BrowserKey::enforced() {
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
fn dispatch_browser_quit(key: BrowserKey) {
    // Same primitive the enforcer used before the responsive-state work:
    // SIGTERM all matching browser processes, then let the 1s loop watch
    // for disappearance and escalate to SIGKILL if the browser lingers.
    use sysinfo::{ProcessesToUpdate, Signal, System};

    let names = key.process_names();
    let matches = |name: &str| -> bool {
        let lower = name.to_ascii_lowercase();
        names
            .iter()
            .any(|n| lower.ends_with(&n.to_ascii_lowercase()))
    };

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for proc_ in sys.processes().values() {
        let name = proc_.name().to_string_lossy().to_string();
        if !matches(&name) {
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
}

#[cfg(target_os = "macos")]
fn force_kill_browser(key: BrowserKey) {
    use sysinfo::{ProcessesToUpdate, System};

    let names = key.process_names();
    let matches = |name: &str| -> bool {
        let lower = name.to_ascii_lowercase();
        names
            .iter()
            .any(|n| lower.ends_with(&n.to_ascii_lowercase()))
    };

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for proc_ in sys.processes().values() {
        let name = proc_.name().to_string_lossy().to_string();
        if !matches(&name) {
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
fn dispatch_browser_quit(key: BrowserKey) {
    use crate::windows_process::hidden_command;

    for name in key.process_names() {
        log::info!("enforcer: requesting graceful close of {name} (taskkill /T)");
        match hidden_command("taskkill").args(["/IM", name, "/T"]).output() {
            Ok(out) => log::debug!(
                "enforcer: taskkill /IM {name} /T -> exit {:?}",
                out.status.code()
            ),
            Err(e) => log::warn!("enforcer: taskkill /IM {name} /T spawn failed: {e}"),
        }
    }
}

#[cfg(target_os = "windows")]
fn force_kill_browser(key: BrowserKey) {
    use crate::windows_process::hidden_command;

    for name in key.process_names() {
        log::info!("enforcer: forcing close of {name} (taskkill /F /T)");
        if let Err(e) = hidden_command("taskkill")
            .args(["/F", "/IM", name, "/T"])
            .output()
        {
            log::warn!("enforcer: taskkill /F /IM {name} /T spawn failed: {e}");
        }
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn dispatch_browser_quit(_key: BrowserKey) {}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn force_kill_browser(_key: BrowserKey) {}
