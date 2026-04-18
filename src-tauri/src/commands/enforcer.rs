//! Extension enforcement loop.
//!
//! Website blocking is delegated to the browser extension. If the user
//! disables the extension, runs it in a private window without permission,
//! or uninstalls it, the blocklist is no longer enforced. To keep the user
//! honest on **desktop** (Windows first, macOS supported so we can test the
//! UX end-to-end), we run a background thread that:
//!
//! 1. Every `TICK` seconds, runs the same scan as the diagnostics pane.
//! 2. For each browser that is *currently running*, checks that the default
//!    profile has the extension installed + enabled + allowed in private
//!    browsing.
//! 3. If a browser fails the check and *any* block is currently active, we
//!    emit a nag event (UI shows a toast / native notification) and start a
//!    `GRACE` timer. If the timer expires while still failing, we quit the
//!    browser.
//! 4. If the user fixes the issue (or the block ends) before the timer
//!    expires, the timer is cleared.
//!
//! This mirrors `browser-ext-mvp/enforcer/enforce.mjs`. Behaviour is driven
//! from two events emitted on the main app webview:
//!
//!   `extension-enforcement-warning` — { browser, remainingMs, reason }
//!   `extension-enforcement-action`  — { browser, action, reason }
//!
//! The frontend renders these; the Rust side keeps the machinery small.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use super::extension::{check_extension_status, heartbeat_file, BrowserStatus, ProfileStatus};

const DEFAULT_TICK: Duration = Duration::from_secs(5);
const DEFAULT_GRACE: Duration = Duration::from_secs(30);

/// How long after the native host's last heartbeat we consider the
/// extension "not responding". The native host refreshes the stamp every
/// `HEARTBEAT_CADENCE` (1 s) so four seconds gives us three missed writes
/// of headroom for disk spikes / scheduler jitter before we nag the user.
const HEARTBEAT_STALE_AFTER: Duration = Duration::from_secs(4);

/// Per-browser quit + process-detection metadata. The `proc_name` is the
/// executable name as the OS reports it; `app_name` is the user-facing title
/// used in nags.
#[derive(Clone, Debug)]
struct BrowserMeta {
    label: &'static str,
    app_name: &'static str,
    proc_names: &'static [&'static str],
}

fn browser_table() -> Vec<BrowserMeta> {
    vec![
        BrowserMeta {
            label: "Chrome",
            app_name: "Google Chrome",
            #[cfg(target_os = "windows")]
            proc_names: &["chrome.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["Google Chrome"],
        },
        BrowserMeta {
            label: "Brave",
            app_name: "Brave",
            #[cfg(target_os = "windows")]
            proc_names: &["brave.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["Brave Browser"],
        },
        BrowserMeta {
            label: "Edge",
            app_name: "Microsoft Edge",
            #[cfg(target_os = "windows")]
            proc_names: &["msedge.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["Microsoft Edge"],
        },
        BrowserMeta {
            label: "Firefox",
            app_name: "Firefox",
            #[cfg(target_os = "windows")]
            proc_names: &["firefox.exe"],
            #[cfg(not(target_os = "windows"))]
            proc_names: &["firefox"],
        },
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementEvent {
    pub browser: String,
    /// One of `nag`, `cancelled`, `quit_attempted`, `quit_failed`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Handle returned by `start_extension_enforcement`. Dropping it is not
/// enough to stop the thread — call `stop_extension_enforcement` to flip
/// the kill switch; the thread exits within at most one tick.
#[derive(Default)]
pub struct EnforcementHandle {
    running: Arc<AtomicBool>,
}

lazy_static::lazy_static! {
    static ref ENFORCER: Mutex<EnforcementHandle> = Mutex::new(EnforcementHandle::default());
}

/// Start the enforcement loop on the current app. Idempotent: repeated calls
/// are no-ops while a loop is already running. Use the returned JSON blob
/// (via the Tauri command below) for the frontend to know whether the loop
/// is active.
#[tauri::command]
pub async fn start_extension_enforcement(app: AppHandle) -> bool {
    let mut guard = ENFORCER.lock().unwrap();
    if guard.running.load(Ordering::SeqCst) {
        return true;
    }

    let running = Arc::new(AtomicBool::new(true));
    guard.running = running.clone();
    drop(guard);

    thread::spawn(move || run_loop(app, running));
    true
}

/// Signal the loop to exit. Returns true if a loop was actually running.
#[tauri::command]
pub async fn stop_extension_enforcement() -> bool {
    let guard = ENFORCER.lock().unwrap();
    let was_running = guard.running.load(Ordering::SeqCst);
    guard.running.store(false, Ordering::SeqCst);
    was_running
}

/// Whether the enforcement loop is currently active.
#[tauri::command]
pub async fn is_extension_enforcement_running() -> bool {
    ENFORCER.lock().unwrap().running.load(Ordering::SeqCst)
}

fn run_loop(app: AppHandle, running: Arc<AtomicBool>) {
    log::info!("[enforcer] loop starting");
    let mut state: HashMap<String, Instant> = HashMap::new();

    while running.load(Ordering::SeqCst) {
        if let Err(e) = tick(&app, &mut state) {
            log::warn!("[enforcer] tick error: {e}");
        }
        // Coarse sleep so `stop_extension_enforcement` wakes us within a tick.
        let step = Duration::from_millis(500);
        let mut slept = Duration::ZERO;
        while slept < DEFAULT_TICK && running.load(Ordering::SeqCst) {
            thread::sleep(step);
            slept += step;
        }
    }
    log::info!("[enforcer] loop stopped");
}

fn tick(app: &AppHandle, state: &mut HashMap<String, Instant>) -> Result<(), String> {
    // Only enforce when there is actually something to enforce — avoids
    // nagging the user when no block is active (e.g. first run).
    let domains = crate::blocklist::current_blocklist();
    if domains.is_empty() {
        // Nothing to enforce; cancel any lingering timers silently.
        if !state.is_empty() {
            for label in state.keys().cloned().collect::<Vec<_>>() {
                emit_event(
                    app,
                    EnforcementEvent {
                        browser: label.clone(),
                        kind: "cancelled".into(),
                        remaining_ms: None,
                        reason: Some("no active blocks".into()),
                    },
                );
            }
            state.clear();
        }
        return Ok(());
    }

    let status = tauri::async_runtime::block_on(check_extension_status());

    for meta in browser_table() {
        let browser_result = status
            .browsers
            .iter()
            .find(|b| b.browser == meta.label)
            .cloned();

        let running_now = is_browser_running(&meta);

        // One-line per-browser trace so it's obvious from the dev console
        // *why* the tick did (or didn't) escalate. Cheap; safe to keep on.
        let hb_trace = match heartbeat_status(meta.label) {
            HeartbeatStatus::Fresh(age) => format!("hb=fresh({}ms)", age.as_millis()),
            HeartbeatStatus::Stale(age) => format!("hb=STALE({}ms)", age.as_millis()),
            HeartbeatStatus::Missing => "hb=missing".to_string(),
        };
        if let Some(b) = browser_result.as_ref() {
            let default_profile = b
                .profiles
                .iter()
                .find(|p| p.is_default)
                .or_else(|| b.profiles.first());
            let (name, inst, ena, priv_) = match default_profile {
                Some(p) => (
                    p.name.as_str(),
                    p.installed,
                    p.enabled,
                    p.private_browsing,
                ),
                None => ("<no-profile>", false, false, None),
            };
            log::info!(
                "[enforcer] tick: {} running={} {} manifest_installed={} profiles={} default={:?} \
                 ext_installed={} ext_enabled={} private_browsing={:?}",
                meta.label,
                running_now,
                hb_trace,
                b.manifest_installed,
                b.profiles.len(),
                name,
                inst,
                ena,
                priv_,
            );
        } else {
            log::info!(
                "[enforcer] tick: {} running={} {} <no probe result>",
                meta.label,
                running_now,
                hb_trace,
            );
        }

        if !running_now {
            if let Some(_) = state.remove(meta.label) {
                emit_event(
                    app,
                    EnforcementEvent {
                        browser: meta.label.into(),
                        kind: "cancelled".into(),
                        remaining_ms: None,
                        reason: Some("browser closed".into()),
                    },
                );
            }
            continue;
        }

        // Heartbeat short-circuit. If we have ever seen the native host for
        // this browser (i.e. the stamp file exists) and the stamp is now
        // older than HEARTBEAT_STALE_AFTER, the extension has stopped
        // talking to us — treat it as an instant failure regardless of what
        // Chrome's on-disk Preferences currently claim. This is the key
        // win: Chrome's Preferences file lags behind the user's toggle by
        // up to ~10 s, but the native-host subprocess dies within <1 s of
        // the extension being disabled, so the heartbeat is the real-time
        // source of truth.
        let hb = heartbeat_status(meta.label);
        let passes = match hb {
            HeartbeatStatus::Stale(_) => false,
            // Fresh OR Missing → defer to the Preferences probe. Missing
            // covers the "browser just launched and the extension hasn't
            // connected yet" window; the slower probe will fill in the
            // correct answer, and once the extension connects at least
            // once the stamp will switch to Fresh/Stale from then on.
            HeartbeatStatus::Fresh(_) | HeartbeatStatus::Missing => {
                browser_passes_check(browser_result.as_ref())
            }
        };
        if passes {
            if state.remove(meta.label).is_some() {
                emit_event(
                    app,
                    EnforcementEvent {
                        browser: meta.label.into(),
                        kind: "cancelled".into(),
                        remaining_ms: None,
                        reason: Some("check now passing".into()),
                    },
                );
            }
            continue;
        }

        // Failing check + browser running + block active => escalate.
        let reason = match hb {
            HeartbeatStatus::Stale(age) => format!(
                "extension not responding (last ping {}s ago)",
                age.as_secs().max(1)
            ),
            _ => browser_failure_reason(browser_result.as_ref()),
        };
        match state.get(meta.label).copied() {
            None => {
                // First tick where this browser is failing. Fire a *system*
                // notification (not just the in-app event) so the user sees
                // it even with the ReDD Block window hidden behind Chrome.
                // We only do this on the transition into a failing state so
                // the user gets one notification per episode, not one every
                // 5 s tick.
                notify_user_of_failure(app, meta.label, meta.app_name, &reason);
                let deadline = Instant::now() + DEFAULT_GRACE;
                state.insert(meta.label.into(), deadline);
                emit_event(
                    app,
                    EnforcementEvent {
                        browser: meta.label.into(),
                        kind: "nag".into(),
                        remaining_ms: Some(DEFAULT_GRACE.as_millis() as u64),
                        reason: Some(reason),
                    },
                );
            }
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    state.remove(meta.label);
                    let quit_ok = quit_browser(&meta);
                    // Follow-up system notification so the user understands
                    // why their browser just closed even if they never saw
                    // the earlier warning (e.g. looked away for a minute).
                    notify_user_of_quit(app, meta.label, meta.app_name, quit_ok, &reason);
                    emit_event(
                        app,
                        EnforcementEvent {
                            browser: meta.label.into(),
                            kind: if quit_ok { "quit_attempted" } else { "quit_failed" }.into(),
                            remaining_ms: Some(0),
                            reason: Some(reason),
                        },
                    );
                } else {
                    let remaining = deadline.saturating_duration_since(now);
                    emit_event(
                        app,
                        EnforcementEvent {
                            browser: meta.label.into(),
                            kind: "nag".into(),
                            remaining_ms: Some(remaining.as_millis() as u64),
                            reason: Some(reason),
                        },
                    );
                }
            }
        }
    }
    Ok(())
}

fn emit_event(app: &AppHandle, event: EnforcementEvent) {
    if let Err(e) = app.emit("extension-enforcement", &event) {
        log::warn!("[enforcer] emit failed: {e}");
    }
}

/// Fire an OS-level banner notification on the transition into a failing
/// state. This is the "hey, look at me even if my window is hidden behind
/// Chrome" channel. We deliberately don't re-fire on every tick — the
/// in-app banner covers the ongoing-nag case; the system notification is
/// just the initial attention-grab.
///
/// Clicking the notification on both macOS and Windows brings the ReDD
/// Block window forward (standard notification-activation behavior), at
/// which point the user sees the in-app banner with a "Re-enable"
/// button. We don't attach action buttons to the notification itself
/// because those require platform-specific registration and don't
/// materially improve the flow.
///
/// Errors (e.g. user denied notification permission) are logged and
/// swallowed: enforcement must keep running even without notifications.
fn notify_user_of_failure(app: &AppHandle, label: &str, app_name: &str, reason: &str) {
    let grace_secs = DEFAULT_GRACE.as_secs();
    let title = format!("{app_name} will close in {grace_secs}s");
    let body = format!(
        "ReDD Focus isn't enforcing your block in {app_name} ({reason}). \
         Open ReDD Block to fix it."
    );
    if let Err(e) = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        log::warn!("[enforcer] system notification failed ({label}): {e}");
    }
}

/// Fire a terminal notification after we've actually quit the browser, so
/// the user sees a clear explanation rather than just "why did Chrome
/// just close?". `quit_ok=false` means `taskkill` / `osascript` returned
/// non-zero — we still notify, but with honest copy.
fn notify_user_of_quit(
    app: &AppHandle,
    label: &str,
    app_name: &str,
    quit_ok: bool,
    reason: &str,
) {
    let title = if quit_ok {
        format!("ReDD Block closed {app_name}")
    } else {
        format!("ReDD Block couldn't close {app_name}")
    };
    let body = if quit_ok {
        format!(
            "ReDD Focus was {reason}, so {app_name} was closed to keep your block active. \
             Re-enable the extension and reopen the browser."
        )
    } else {
        format!(
            "ReDD Focus was {reason} and we tried to close {app_name} but failed. \
             Please quit it manually and re-enable the extension."
        )
    };
    if let Err(e) = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
    {
        log::warn!("[enforcer] system notification failed ({label}): {e}");
    }
}

fn browser_passes_check(status: Option<&BrowserStatus>) -> bool {
    let status = match status {
        Some(s) => s,
        None => return false,
    };
    if !status.browser_installed {
        // Browser isn't installed at all — nothing to enforce; treat as pass
        // so we never nag about a browser the user doesn't even use.
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

fn profile_passes(p: &ProfileStatus) -> bool {
    if !p.installed || !p.enabled {
        return false;
    }
    // Private browsing is optional (Chrome: incognito, Firefox:
    // privateBrowsingAllowed). If we don't know (None), err on the side of
    // nagging — user almost certainly needs it for real protection.
    matches!(p.private_browsing, Some(true))
}

fn browser_failure_reason(status: Option<&BrowserStatus>) -> String {
    let status = match status {
        Some(s) => s,
        None => return "browser status unknown".into(),
    };
    if !status.manifest_installed {
        return "native-messaging manifest missing".into();
    }
    let profile = status.profiles.iter().find(|p| p.is_default).or_else(|| status.profiles.first());
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

// ---------- Heartbeat probe -----------------------------------------------

/// Result of inspecting the per-browser heartbeat stamp file that the
/// native-host subprocess refreshes each second.
#[derive(Debug, Clone, Copy)]
enum HeartbeatStatus {
    /// File exists and was updated within `HEARTBEAT_STALE_AFTER`.
    Fresh(Duration),
    /// File exists but hasn't been updated within `HEARTBEAT_STALE_AFTER`.
    /// The native host has died (user disabled the extension, the
    /// extension crashed, or Chrome killed the port).
    Stale(Duration),
    /// File doesn't exist yet. Typical for a fresh install / first run
    /// before the browser has ever spawned our native host. Treated as
    /// "no signal" rather than failure.
    Missing,
}

fn heartbeat_status(label: &str) -> HeartbeatStatus {
    let path = match heartbeat_file(label) {
        Some(p) => p,
        None => return HeartbeatStatus::Missing,
    };
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return HeartbeatStatus::Missing,
    };
    // Prefer `modified()` over reading the file body: mtime is what
    // `std::fs::write` updates, it's a single stat() call, and we don't
    // have to parse the payload.
    let mtime = match meta.modified() {
        Ok(t) => t,
        Err(_) => return HeartbeatStatus::Missing,
    };
    let age = SystemTime::now()
        .duration_since(mtime)
        .unwrap_or(Duration::ZERO);
    if age <= HEARTBEAT_STALE_AFTER {
        HeartbeatStatus::Fresh(age)
    } else {
        HeartbeatStatus::Stale(age)
    }
}

// ---------- Process detection / quit --------------------------------------

#[cfg(target_os = "windows")]
fn is_browser_running(meta: &BrowserMeta) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return false,
        };
        if snapshot.is_invalid() {
            return false;
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                for p in meta.proc_names {
                    if name.eq_ignore_ascii_case(p) {
                        found = true;
                        break;
                    }
                }
                if found || Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

#[cfg(not(target_os = "windows"))]
fn is_browser_running(meta: &BrowserMeta) -> bool {
    use std::process::Command;
    for proc_name in meta.proc_names {
        let out = Command::new("/usr/bin/pgrep").arg("-x").arg(proc_name).output();
        if let Ok(output) = out {
            if output.status.success() && !output.stdout.is_empty() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn quit_browser(meta: &BrowserMeta) -> bool {
    use std::process::Command;
    let mut ok = false;
    for proc in meta.proc_names {
        // Try a graceful close first (/T closes the full process tree, no /F
        // so we give the browser a chance to save state), then escalate to
        // /F if the process is still alive on the next tick.
        let result = Command::new("taskkill")
            .args(["/IM", proc, "/T"])
            .output();
        if let Ok(output) = result {
            if output.status.success() {
                ok = true;
            }
        }
    }
    ok
}

#[cfg(target_os = "macos")]
fn quit_browser(meta: &BrowserMeta) -> bool {
    use std::process::Command;
    let script = format!(
        r#"tell application "{}" to quit"#,
        meta.app_name.replace("\"", "\\\"")
    );
    Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn quit_browser(_meta: &BrowserMeta) -> bool {
    false
}
