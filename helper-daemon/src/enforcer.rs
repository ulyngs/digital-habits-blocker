//! Website-blocking enforcement loop — the one that nags the user / quits
//! their browser when the ReDD Focus extension is disabled while a block
//! is active.
//!
//! This loop used to live inside the Tauri app. It was moved into the
//! helper daemon so enforcement survives the main app being quit — the
//! helper is always running (LaunchDaemon on macOS, scheduled-task on
//! Windows), so the block keeps getting enforced even if the user force-
//! quits ReDD Block.
//!
//! The loop itself is nearly identical to the old
//! `src-tauri/src/commands/enforcer.rs`. What differs is:
//!
//! - Paths under the user's home are resolved via
//!   [`redd_block_core::user::effective_user_home`] because on macOS the
//!   helper runs as `root` (whose `~` is `/var/root`), not as the logged-
//!   in user.
//! - GUI alerts use `launchctl asuser <uid> /usr/bin/osascript` on macOS
//!   because a root-context AppleScript dialog is not visible to the
//!   logged-in user. Windows alerts use PowerShell.
//! - Instead of emitting Tauri events, we push events into an in-memory
//!   queue drained over the helper's IPC socket.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use redd_block_core::browser::{
    browser_table, BrowserMeta, BrowserStatus,
};
use redd_block_core::enforcement::{
    action_button_label, browser_failure_reason, browser_passes_check, failure_kind_for,
    failure_message_body, EnforcementEvent, EnforcementSnapshot, FailureKind, PerBrowserState,
};
use redd_block_core::heartbeat::{heartbeat_status, HeartbeatStatus};
use redd_block_core::user::effective_user_home;

use crate::alert;
use crate::process;

// The same tuning constants as the old in-process enforcer.
const TICK: Duration = Duration::from_millis(500);
const DEFAULT_GRACE: Duration = Duration::from_secs(30);

/// How many events we keep buffered in the outbound queue before we
/// start dropping the oldest. The Tauri app polls every ~500 ms so
/// 256 is generous (~2 minutes worth of sustained high-rate
/// transitions).
const EVENT_BUFFER_SIZE: usize = 256;

/// Shared state owned by the helper's `main()` and queried by the IPC
/// handler. The enforcer thread is the sole writer.
#[derive(Default)]
pub struct SharedState {
    /// Latest snapshot the enforcer published. Updated every tick.
    snapshot: Mutex<EnforcementSnapshot>,
    /// Rolling buffer of delta events since the helper started. Each
    /// event gets a monotonic `cursor` so the Tauri app can ask "give
    /// me everything newer than X" without missing transitions.
    events: Mutex<Vec<(u64, EnforcementEvent)>>,
    /// Next cursor to assign. Monotonic across the helper's lifetime.
    next_cursor: AtomicU64,
    /// Kill switch. Flipping this to `false` stops the enforcer loop
    /// within one `TICK`.
    running: AtomicBool,
}

impl SharedState {
    pub fn new() -> Arc<Self> {
        Arc::new(SharedState {
            snapshot: Mutex::new(EnforcementSnapshot::default()),
            events: Mutex::new(Vec::with_capacity(EVENT_BUFFER_SIZE)),
            next_cursor: AtomicU64::new(1),
            running: AtomicBool::new(true),
        })
    }

    pub fn snapshot(&self) -> EnforcementSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    /// Return events with `cursor > since`, sorted by cursor ascending,
    /// and the highest cursor currently in the buffer (so the caller
    /// can pass that as `since` next time).
    pub fn events_since(&self, since: u64) -> (Vec<EnforcementEvent>, u64) {
        let events = self.events.lock().unwrap();
        let mut out = Vec::new();
        let mut max_cursor = since;
        for (cursor, ev) in events.iter() {
            if *cursor > since {
                out.push(ev.clone());
            }
            if *cursor > max_cursor {
                max_cursor = *cursor;
            }
        }
        (out, max_cursor)
    }

    fn publish_event(&self, event: EnforcementEvent) {
        let cursor = self.next_cursor.fetch_add(1, Ordering::SeqCst);
        let mut events = self.events.lock().unwrap();
        if events.len() >= EVENT_BUFFER_SIZE {
            events.remove(0);
        }
        events.push((cursor, event));
    }

    fn set_snapshot(&self, snap: EnforcementSnapshot) {
        *self.snapshot.lock().unwrap() = snap;
    }
}

/// Start the enforcement thread. Returns immediately; the thread lives
/// for the lifetime of the helper daemon (there's no stop API — when a
/// block is inactive the loop just idles publishing an `active=false`
/// snapshot).
pub fn spawn(state: Arc<SharedState>) {
    thread::spawn(move || run_loop(state));
}

fn run_loop(state: Arc<SharedState>) {
    log::info!("[enforcer] loop starting");
    let mut per_browser: HashMap<String, Instant> = HashMap::new();

    while state.running.load(Ordering::SeqCst) {
        let _ = tick(&state, &mut per_browser);
        // Poll quickly so the Tauri app sees transitions within ~1 tick.
        thread::sleep(TICK);
    }
    log::info!("[enforcer] loop stopped");
}

fn tick(
    state: &Arc<SharedState>,
    per_browser: &mut HashMap<String, Instant>,
) -> Result<(), String> {
    // Early exit when no block is active. We still publish a snapshot
    // so the Tauri app knows enforcement is dormant (no banner).
    let domains = redd_block_core::blocklist::current_blocklist();
    if domains.is_empty() {
        // Clear any lingering countdowns; emit one `cancelled` per
        // browser on the transition so the banner disappears.
        if !per_browser.is_empty() {
            for label in per_browser.keys().cloned().collect::<Vec<_>>() {
                state.publish_event(EnforcementEvent {
                    browser: label.clone(),
                    kind: "cancelled".into(),
                    remaining_ms: None,
                    reason: Some("no active blocks".into()),
                    failure_kind: None,
                });
            }
            per_browser.clear();
        }
        state.set_snapshot(EnforcementSnapshot {
            active: false,
            browsers: Vec::new(),
        });
        return Ok(());
    }

    let user_home = effective_user_home();

    // Probe every browser once per tick.
    let mut snapshot_rows: Vec<PerBrowserState> = Vec::new();

    for meta in browser_table() {
        let (hb, probe) = probe_for(&user_home, &meta);
        let running = process::is_browser_running(&meta);

        // Human-readable trace for debugging; keep at info so it shows
        // up in helper.log on both platforms.
        let hb_str = match hb {
            HeartbeatStatus::Fresh(a) => format!("hb=fresh({}ms)", a.as_millis()),
            HeartbeatStatus::Stale(a) => format!("hb=STALE({}ms)", a.as_millis()),
            HeartbeatStatus::Missing => "hb=missing".into(),
        };
        log::debug!(
            "[enforcer] tick: {} running={} {} manifest={} profiles={}",
            meta.label,
            running,
            hb_str,
            probe.as_ref().map(|p| p.manifest_installed).unwrap_or(false),
            probe.as_ref().map(|p| p.profiles.len()).unwrap_or(0),
        );

        // Not running? Cancel any in-flight countdown, record a
        // not-failing row so the UI shows nothing, and move on.
        if !running {
            if per_browser.remove(meta.label).is_some() {
                state.publish_event(EnforcementEvent {
                    browser: meta.label.into(),
                    kind: "cancelled".into(),
                    remaining_ms: None,
                    reason: Some("browser closed".into()),
                    failure_kind: None,
                });
            }
            snapshot_rows.push(PerBrowserState {
                browser: meta.label.into(),
                app_name: meta.app_name.into(),
                failing: false,
                kind: None,
                reason: None,
                remaining_ms: None,
            });
            continue;
        }

        // Combine the fast heartbeat signal with the slower Preferences
        // probe (same rule as the old in-process enforcer): stale
        // heartbeat = fail immediately; fresh/missing heartbeat = defer
        // to the Preferences probe.
        let passes = match hb {
            HeartbeatStatus::Stale(_) => false,
            HeartbeatStatus::Fresh(_) | HeartbeatStatus::Missing => {
                browser_passes_check(probe.as_ref())
            }
        };

        if passes {
            if per_browser.remove(meta.label).is_some() {
                state.publish_event(EnforcementEvent {
                    browser: meta.label.into(),
                    kind: "cancelled".into(),
                    remaining_ms: None,
                    reason: Some("check now passing".into()),
                    failure_kind: None,
                });
            }
            snapshot_rows.push(PerBrowserState {
                browser: meta.label.into(),
                app_name: meta.app_name.into(),
                failing: false,
                kind: None,
                reason: None,
                remaining_ms: None,
            });
            continue;
        }

        let kind = failure_kind_for(hb, probe.as_ref());
        let reason = match hb {
            HeartbeatStatus::Stale(age) => format!(
                "extension not responding (last ping {}s ago)",
                age.as_secs().max(1)
            ),
            _ => browser_failure_reason(probe.as_ref()),
        };

        match per_browser.get(meta.label).copied() {
            None => {
                // First tick of a new failing episode. Fire the GUI
                // alert so the user sees it even if the ReDD Block
                // window is hidden (or the app is quit entirely).
                fire_alert(&meta, kind, &reason);
                let deadline = Instant::now() + DEFAULT_GRACE;
                per_browser.insert(meta.label.into(), deadline);
                state.publish_event(EnforcementEvent {
                    browser: meta.label.into(),
                    kind: "nag".into(),
                    remaining_ms: Some(DEFAULT_GRACE.as_millis() as u64),
                    reason: Some(reason.clone()),
                    failure_kind: Some(kind),
                });
                snapshot_rows.push(PerBrowserState {
                    browser: meta.label.into(),
                    app_name: meta.app_name.into(),
                    failing: true,
                    kind: Some(kind),
                    reason: Some(reason),
                    remaining_ms: Some(DEFAULT_GRACE.as_millis() as u64),
                });
            }
            Some(deadline) => {
                let now = Instant::now();
                if now >= deadline {
                    per_browser.remove(meta.label);
                    let quit_ok = process::quit_browser(&meta);
                    // Terminal notification so the user understands
                    // why their browser just closed.
                    alert::quit_notification(&meta, quit_ok, &reason);
                    state.publish_event(EnforcementEvent {
                        browser: meta.label.into(),
                        kind: if quit_ok { "quit_attempted" } else { "quit_failed" }
                            .into(),
                        remaining_ms: Some(0),
                        reason: Some(reason.clone()),
                        failure_kind: Some(kind),
                    });
                    snapshot_rows.push(PerBrowserState {
                        browser: meta.label.into(),
                        app_name: meta.app_name.into(),
                        failing: true,
                        kind: Some(kind),
                        reason: Some(reason),
                        remaining_ms: Some(0),
                    });
                } else {
                    let remaining = deadline.saturating_duration_since(now);
                    state.publish_event(EnforcementEvent {
                        browser: meta.label.into(),
                        kind: "nag".into(),
                        remaining_ms: Some(remaining.as_millis() as u64),
                        reason: Some(reason.clone()),
                        failure_kind: Some(kind),
                    });
                    snapshot_rows.push(PerBrowserState {
                        browser: meta.label.into(),
                        app_name: meta.app_name.into(),
                        failing: true,
                        kind: Some(kind),
                        reason: Some(reason),
                        remaining_ms: Some(remaining.as_millis() as u64),
                    });
                }
            }
        }
    }

    state.set_snapshot(EnforcementSnapshot {
        active: true,
        browsers: snapshot_rows,
    });
    Ok(())
}

/// Run the heartbeat + on-disk probe for a single browser. Returns the
/// heartbeat status and (optionally) the full probe result — if the
/// user's home dir can't be resolved we still return *something* so the
/// tick isn't a no-op.
fn probe_for(
    user_home: &Option<std::path::PathBuf>,
    meta: &BrowserMeta,
) -> (HeartbeatStatus, Option<BrowserStatus>) {
    let home = match user_home {
        Some(h) => h,
        None => {
            return (HeartbeatStatus::Missing, None);
        }
    };
    let hb = heartbeat_status(home, meta.label);
    let probe = match meta.label {
        "Firefox" => Some(redd_block_core::browser::probe_firefox(home, manifest_installed(home, meta.label), None)),
        _ => Some(redd_block_core::browser::probe_chromium(home, meta.label, manifest_installed(home, meta.label), None)),
    };
    (hb, probe)
}

/// Best-effort manifest-installed check. On macOS we stat the file we
/// dropped into `~/Library/.../NativeMessagingHosts/`. On Windows we
/// leave it to `false` — the Tauri app is the source of truth for
/// HKCU registry lookups, and the heartbeat / prefs probe will report
/// the same "extension not enforcing" state regardless.
fn manifest_installed(home: &std::path::Path, label: &str) -> bool {
    redd_block_core::browser::is_manifest_installed(home, label)
}

fn fire_alert(meta: &BrowserMeta, kind: FailureKind, reason: &str) {
    let grace_secs = DEFAULT_GRACE.as_secs();
    let title = format!("{} will close in {grace_secs}s", meta.app_name);
    let body = failure_message_body(kind, meta, reason);
    let button = action_button_label(kind, meta);
    alert::failure_alert(meta, kind, &title, &body, &button);
}
