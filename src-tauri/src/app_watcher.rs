// In-process app watcher.
//
// Replaces the helper-daemon's privileged watcher. Runs as the user
// and works without elevation, AppleScript, or Accessibility/Automation
// TCC. Polling sysinfo is dumber than NSWorkspace notifications but
// reliable — the previous AppleScript-based observer was unable to
// deliver activate-notifications because AppleScript's `delay` doesn't
// pump the Cocoa run loop.
//
// Behaviour (per blocked-app PID):
//
//   1. **AwaitingUserAck.** First sighting raises the always-on-top
//      "Let's go!" warning overlay (`app-blocking://warning-show`) and
//      sits idle. *No* polite quit is sent yet — the warning is the
//      user's chance to save unsaved work, and the user clicks
//      "Let's go!" to acknowledge once they're ready.
//
//   2. **PreQuit.** When the user clicks Let's go (frontend invokes
//      `lets_go_acknowledge`), every PID in AwaitingUserAck moves to
//      PreQuit with a 30-second timer. The warning stays up. The user
//      uses these 30 seconds to save + manually quit; the watcher
//      stays out of the way.
//
//   3. **PostQuit.** When the 30 seconds elapse, we send the platform's
//      polite quit — `[NSRunningApplication terminate]` on macOS,
//      `taskkill /PID <pid>` (no `/F`) on Windows. Both run the app's
//      normal terminate path, including any "save changes?" sheet for
//      dirty documents. We never use POSIX SIGTERM here: it bypasses
//      Cocoa's `applicationShouldTerminate:` and would silently
//      destroy unsaved work — exactly what this design exists to
//      avoid. The PID transitions to PostQuit with a 10-second timer.
//
//   4. **SIGKILL.** If the PID is still alive after the 10-second
//      PostQuit grace, we SIGKILL it. This is the *only* path that
//      can destroy unsaved work from the watcher.
//
// PIDs that disappear at any phase (the user saved + quit themselves)
// just dissolve out of the state machine; the warning hides cleanly.
//
// `is_protected` keeps us from ever quitting Fristed, the OS
// loginwindow, Finder, etc.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub type BlockedApps = Arc<RwLock<HashSet<String>>>;

/// Steady-state poll cadence while a schedule is active but no blocked
/// app is currently being tracked — the common idle case. We only need
/// to notice a newly-launched blocked app within a couple of seconds,
/// so polling slower here roughly halves background CPU/battery cost
/// versus the old fixed 1s sweep.
const POLL_INTERVAL: Duration = Duration::from_millis(2000);
/// Faster cadence while at least one PID is mid-countdown (PreQuit /
/// PostQuit) so the warning overlay and grace timers stay responsive.
const POLL_INTERVAL_ACTIVE: Duration = Duration::from_millis(1000);
/// After the user clicks "Let's go!", how long they get to save +
/// manually quit before the watcher sends the polite Cmd-Q.
const PREQUIT_DURATION: Duration = Duration::from_secs(30);
/// After the watcher sends the polite Cmd-Q, how long it waits before
/// SIGKILLing if the PID is still alive. Long enough to clear a
/// "save?" sheet, short enough that the user can't stall forever.
const POSTQUIT_GRACE: Duration = Duration::from_secs(10);

/// Set by the `lets_go_acknowledge` Tauri command. The next sweep
/// observes the flag (atomically swapping it back to false) and
/// transitions every PID currently in `AwaitingUserAck` to `PreQuit`.
static USER_ACK_PENDING: AtomicBool = AtomicBool::new(false);

pub fn user_acknowledge_warning() {
    USER_ACK_PENDING.store(true, Ordering::SeqCst);
}

const PROTECTED: &[&str] = &[
    "Fristed", "ReDD Block", "redd-block", "ReddBlock",
    "System Events", "Finder", "loginwindow", "WindowServer",
    "explorer.exe", "dwm.exe", "winlogon.exe", "svchost.exe",
];

fn is_protected(name: &str) -> bool {
    is_protected_app_name(name)
}

/// Whether an app label must never be killed by the watcher.
pub fn is_protected_app_name(name: &str) -> bool {
    PROTECTED.iter().any(|p| name.eq_ignore_ascii_case(p))
}

/// Match a running process against a user-facing blocked-app label.
/// On macOS the label is usually the `.app` bundle name (e.g.
/// "Android Studio") while `sysinfo` reports the bundle executable
/// (e.g. "studio") — also accept processes whose path lives inside
/// `/Applications/<label>.app/`.
fn process_matches_blocked(blocked: &str, proc_name: &str, proc_exe: Option<&std::path::Path>) -> bool {
    let stem = proc_name.strip_suffix(".exe").unwrap_or(proc_name);
    if blocked.eq_ignore_ascii_case(proc_name) || blocked.eq_ignore_ascii_case(stem) {
        return true;
    }
    #[cfg(target_os = "macos")]
    if let Some(exe) = proc_exe {
        let needle = format!("/{}.app/", blocked);
        if exe
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains(&needle.to_ascii_lowercase())
        {
            return true;
        }
    }
    false
}

// ---- Public handle --------------------------------------------------------

/// Names that should get the AwaitingUserAck warning on their NEXT
/// first-sighting. Populated by `set_apps` with the (new − old) diff —
/// i.e. apps that just got added to the blocked set because a block
/// started. Drained by the next sweep so the warning eligibility is
/// strictly one-shot: mid-block app launches (apps that were already
/// in the blocked set when the user opened them) skip the warning and
/// go straight to silent Cmd-Q + grace + SIGKILL.
type PendingWarningApps = Arc<Mutex<HashSet<String>>>;

/// Public handle returned from `start`. Use `set_apps` to update the
/// effective blocked set; drop-or-call-`stop` to tear down the watcher.
pub struct Handle {
    apps: BlockedApps,
    pending_warning_apps: PendingWarningApps,
    stop: Arc<AtomicBool>,
    join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Handle {
    /// Update the effective blocked-app set. The frontend passes the
    /// full new set as `names` and, separately, the subset that just
    /// transitioned from "not blocked" to "blocked" as `newly_added`
    /// — those are the apps that should raise the Let's-go warning
    /// on their next first-sighting (block-just-starting path), as
    /// opposed to mid-block app launches which get the silent SIGTERM
    /// path. The frontend is the source of truth for that transition
    /// because it owns block / schedule lifecycle and can distinguish
    /// "app-launch initialization" (no warnings) from "user just
    /// started a block / a schedule just fired" (warn for everything
    /// in `newly_added`).
    pub fn set_apps(&self, names: Vec<String>, newly_added: Vec<String>) {
        log::info!(
            "app_watcher::set_apps called: {} blocked, {} newly added",
            names.len(),
            newly_added.len()
        );
        if let Ok(mut w) = self.apps.write() {
            w.clear();
            for n in names {
                if is_protected(&n) {
                    continue;
                }
                w.insert(n);
            }
        }
        if !newly_added.is_empty() {
            if let Ok(mut p) = self.pending_warning_apps.lock() {
                for n in newly_added {
                    if !is_protected(&n) {
                        p.insert(n);
                    }
                }
            }
        }
        // The poll loop picks up the new set on its next tick — no
        // need for an immediate sweep here.
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = self.join.lock() {
            if let Some(j) = slot.take() {
                let _ = j.join();
            }
        }
    }

    /// Snapshot of the currently effective blocked-app set, sorted
    /// alphabetically. Used by the diagnostics surface so the user
    /// can sanity-check what the watcher is actually enforcing right
    /// now.
    pub fn current_apps(&self) -> Vec<String> {
        match self.apps.read() {
            Ok(h) => {
                let mut v: Vec<String> = h.iter().cloned().collect();
                v.sort();
                v
            }
            Err(_) => Vec::new(),
        }
    }
}

/// Start the watcher. One polling thread per Handle.
///
/// `app` is `Option` so the standalone `examples/test_watcher`
/// exerciser — which has no Tauri context — can still spin up the
/// watcher. In production the `set_blocked_apps` command always
/// passes `Some(app_handle)`, which the worker uses to emit warning
/// events to the frontend. With `app == None`, the watcher still
/// runs the full state machine but events are dropped on the floor
/// (no frontend to render them anyway).
pub fn start(app: Option<AppHandle>) -> Handle {
    let apps: BlockedApps = Arc::new(RwLock::new(HashSet::new()));
    let pending_warning_apps: PendingWarningApps = Arc::new(Mutex::new(HashSet::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let apps_for_thread = apps.clone();
    let pending_for_thread = pending_warning_apps.clone();
    let stop_for_thread = stop.clone();
    let join = std::thread::spawn(move || {
        run(app, apps_for_thread, pending_for_thread, stop_for_thread)
    });
    Handle {
        apps,
        pending_warning_apps,
        stop,
        join: Mutex::new(Some(join)),
    }
}

// ---- Event payloads -------------------------------------------------------

/// Emitted once when a PID transitions into the warning phase.
#[derive(Clone, Debug, Serialize)]
struct WarningShow {
    pid: u32,
    name: String,
}

/// Emitted when a PID leaves the warning phase, regardless of cause.
/// `reason` lets the UI distinguish "the user saved + quit" (stop
/// showing the warning silently) from "we force-killed" (show a
/// post-mortem toast so they know their work is gone).
#[derive(Clone, Debug, Serialize)]
struct WarningHide {
    pid: u32,
    name: String,
    reason: HideReason,
}

#[derive(Clone, Debug, Serialize, Copy)]
#[serde(rename_all = "snake_case")]
enum HideReason {
    /// App exited cleanly (user saved or discarded, OR user clicked
    /// the explicit "Force-quit" button) before the countdown
    /// elapsed. Watcher discovered the PID is gone.
    Resolved,
    /// Countdown elapsed with user active; we SIGKILLed.
    ForceKilled,
}

/// How many blocked apps are currently in the warning phase —
/// drives `set_blocking_warning_attention` ref-counting.
static BLOCKING_WARNING_LAYERS: AtomicU32 = AtomicU32::new(0);

pub(crate) fn blocking_warning_begin(app: Option<&AppHandle>) {
    let prev = BLOCKING_WARNING_LAYERS.fetch_add(1, Ordering::SeqCst);
    if prev == 0 {
        #[cfg(target_os = "macos")]
        {
            // Dock + app menu appear when the countdown is visible, but we avoid
            // `NSApplication activateIgnoringOtherApps` so the blocked app can
            // remain the key app while the warning floats on top.
            crate::set_macos_activation_policy(true);
        }
        if let Some(a) = app {
            crate::commands::set_blocking_warning_attention(a, true);
            crate::commands::enter_blocking_warning_compact_window(a);
        }
    }
}

pub(crate) fn blocking_warning_end(app: Option<&AppHandle>) {
    // Saturating decrement so a force-dismiss (which zeroes the refcount,
    // see `force_dismiss_warning_overlay`) doesn't underflow when the
    // still-tracked PIDs eventually exit and hit this path.
    let prev = BLOCKING_WARNING_LAYERS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
            Some(v.saturating_sub(1))
        })
        .unwrap_or(0);
    if prev == 1 {
        if let Some(a) = app {
            crate::commands::leave_blocking_warning_compact_window(a);
            crate::commands::set_blocking_warning_attention(a, false);
        }
    }
}

/// Force the panel-mode window back to its normal size + level *now*,
/// regardless of how many PIDs are still in flight. Called when the
/// user clicks "Let's go!" — the warning UI is dismissed even though
/// the watcher continues running its 30s + 10s timers in the background.
/// The refcount is reset to 0 so a NEW first-sighting (e.g. a fresh
/// blocked app launched during the wrap-up window) properly re-enters
/// panel mode from a clean slate.
pub(crate) fn force_dismiss_warning_overlay(app: Option<&AppHandle>) {
    BLOCKING_WARNING_LAYERS.store(0, Ordering::SeqCst);
    if let Some(a) = app {
        crate::commands::leave_blocking_warning_compact_window(a);
        crate::commands::set_blocking_warning_attention(a, false);
    }
}

fn emit_warning_show(app: Option<&AppHandle>, pid: u32, name: &str, _total_secs: u64) {
    blocking_warning_begin(app);
    if let Some(a) = app {
        crate::commands::show_blocking_warning_shell_without_stealing_focus(a);
        crate::commands::activate_external_process_by_pid(pid);
    }
    if let Some(app) = app {
        let _ = app.emit(
            "app-blocking://warning-show",
            WarningShow {
                pid,
                name: name.to_string(),
            },
        );
    }
}

fn emit_warning_hide(app: Option<&AppHandle>, pid: u32, name: &str, reason: HideReason) {
    if let Some(app) = app {
        let _ = app.emit(
            "app-blocking://warning-hide",
            WarningHide {
                pid,
                name: name.to_string(),
                reason,
            },
        );
    }
    blocking_warning_end(app);
}

// ---- Per-PID state machine ------------------------------------------------

#[derive(Debug)]
enum PidPhase {
    /// First sighting. Warning overlay is up; we're waiting for the
    /// user to click "Let's go!". No quit signal sent yet.
    AwaitingUserAck,
    /// User acknowledged. Polite Cmd-Q will be sent at `quit_at`.
    PreQuit { quit_at: Instant },
    /// Polite Cmd-Q has been sent. SIGKILL at `kill_at` if still alive.
    PostQuit { kill_at: Instant },
}

#[derive(Debug)]
struct PidEntry {
    /// The user-list name we matched against this process — emitted
    /// to the UI so the warning shows "Microsoft Word" instead of
    /// the kernel binary name. Stays stable across the entry's
    /// lifetime even if the user later removes the app from the
    /// blocklist (we still need to honour the in-flight warning).
    matched_name: String,
    phase: PidPhase,
    /// `true` iff this PID's lifecycle started with a `warning-show`
    /// (block-start path). Mid-block sightings go straight to PostQuit
    /// without raising a warning, and they must NOT emit
    /// `warning-hide` later — the refcount inside `blocking_warning_*`
    /// would underflow / falsely tear down panel mode while a
    /// concurrent block-start warning is still up.
    warning_raised: bool,
}

// ---- Run loop -------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run(
    app: Option<AppHandle>,
    apps: BlockedApps,
    pending_warning_apps: PendingWarningApps,
    stop: Arc<AtomicBool>,
) {
    let mut entries: HashMap<sysinfo::Pid, PidEntry> = HashMap::new();
    // One `System` kept alive across sweeps so sysinfo does incremental
    // diffs — and caches each process's exe path — instead of building a
    // fresh table and re-reading the whole process list cold every tick.
    let mut sys = sysinfo::System::new();
    while !stop.load(Ordering::SeqCst) {
        sweep(app.as_ref(), &apps, &pending_warning_apps, &mut entries, &mut sys);
        // Poll fast only while a countdown is in flight; otherwise idle
        // at the slower cadence to keep background CPU / battery low.
        let interval = if entries.is_empty() {
            POLL_INTERVAL
        } else {
            POLL_INTERVAL_ACTIVE
        };
        std::thread::sleep(interval);
    }
    // On stop: clear any in-flight warnings so the UI doesn't keep
    // showing a stale modal after the watcher's gone. Mid-block PIDs
    // (warning_raised=false) never emitted a show, so they don't
    // emit a hide either — keeps the panel-mode refcount balanced.
    for (pid, entry) in entries.drain() {
        if entry.warning_raised {
            emit_warning_hide(app.as_ref(), pid.as_u32(), &entry.matched_name, HideReason::Resolved);
        }
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn run(
    _app: Option<AppHandle>,
    _apps: BlockedApps,
    _pending_warning_apps: PendingWarningApps,
    _stop: Arc<AtomicBool>,
) {
    // Linux has no in-process watcher; blocking apps would need a
    // distro-specific approach (e.g. cgroup freezer) — out of scope.
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn sweep(
    app: Option<&AppHandle>,
    apps: &BlockedApps,
    pending_warning_apps: &PendingWarningApps,
    entries: &mut HashMap<sysinfo::Pid, PidEntry>,
    sys: &mut sysinfo::System,
) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

    let blocked: Vec<String> = match apps.read() {
        Ok(g) => g.iter().cloned().collect(),
        Err(_) => return,
    };

    // One-shot snapshot — the names in here are eligible for the
    // AwaitingUserAck warning on this sweep's first-sighting. Drained
    // so subsequent sweeps see an empty set and route mid-block app
    // launches straight to the silent Cmd-Q path.
    let pending_warn: HashSet<String> = match pending_warning_apps.lock() {
        Ok(mut p) => p.drain().collect(),
        Err(_) => HashSet::new(),
    };
    if blocked.is_empty() {
        if !entries.is_empty() {
            // Block ended (e.g. user paused / cleared) — clear any
            // in-flight warnings so the UI stops showing them. Skip
            // hide-emit for mid-block PIDs (warning_raised=false)
            // since they never had a corresponding show.
            for (pid, entry) in entries.drain() {
                if entry.warning_raised {
                    emit_warning_hide(
                        app,
                        pid.as_u32(),
                        &entry.matched_name,
                        HideReason::Resolved,
                    );
                }
            }
        }
        return;
    }

    // Refresh only what we match on: the process name (always present)
    // plus the executable path. `OnlyIfNotSet` fetches the exe once per
    // PID and caches it on the persistent `System`, so steady-state
    // sweeps skip the per-process exe syscall entirely. We deliberately
    // skip CPU/memory/disk/user/cmd/env refresh — the default
    // `refresh_processes` pulls all of that for every process each tick.
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );

    let now = Instant::now();
    let mut still_alive: HashSet<sysinfo::Pid> = HashSet::new();

    // If the user clicked "Let's go!" since the last sweep, transition
    // every PID currently in `AwaitingUserAck` into `PreQuit`. Atomic
    // swap so we consume the signal exactly once.
    let user_acked = USER_ACK_PENDING.swap(false, Ordering::SeqCst);
    if user_acked {
        for entry in entries.values_mut() {
            if matches!(entry.phase, PidPhase::AwaitingUserAck) {
                log::info!(
                    "app_watcher: user ack received for '{}'; entering PreQuit",
                    entry.matched_name
                );
                entry.phase = PidPhase::PreQuit { quit_at: now + PREQUIT_DURATION };
            }
        }
    }

    for (pid, proc_) in sys.processes() {
        let name = proc_.name().to_string_lossy().to_string();
        if name.is_empty() || is_protected(&name) {
            continue;
        }
        let proc_exe = proc_.exe();
        let matched_name = match blocked
            .iter()
            .find(|b| process_matches_blocked(b, &name, proc_exe))
        {
            Some(n) => n.clone(),
            None => continue,
        };
        still_alive.insert(*pid);

        match entries.entry(*pid) {
            Entry::Vacant(slot) => {
                if pending_warn.contains(&matched_name) {
                    // Block-just-starting path: raise the user-ack
                    // warning and wait for the "Let's go!" click. No
                    // quit signal sent yet — the user gets a clean
                    // 30-second wrap-up window once they acknowledge.
                    log::info!(
                        "app_watcher: block-start sighting pid={pid} name='{name}'; raising user-ack warning"
                    );
                    emit_warning_show(
                        app,
                        pid.as_u32(),
                        &matched_name,
                        PREQUIT_DURATION.as_secs(),
                    );
                    slot.insert(PidEntry {
                        matched_name,
                        phase: PidPhase::AwaitingUserAck,
                        warning_raised: true,
                    });
                } else {
                    // Mid-block app launch — the user opened a
                    // blocked app while a block was already running,
                    // so they already saw the warning at block start
                    // (or chose to launch it knowing the consequences).
                    // Fast SIGTERM (no activation flash, no Apple
                    // Event roundtrip) + 10s grace + SIGKILL. No
                    // overlay, no banner.
                    log::info!(
                        "app_watcher: mid-block sighting pid={pid} name='{name}'; SIGTERM (no warning)"
                    );
                    request_silent_quit(*pid, &name, proc_);
                    slot.insert(PidEntry {
                        matched_name,
                        phase: PidPhase::PostQuit { kill_at: now + POSTQUIT_GRACE },
                        warning_raised: false,
                    });
                }
            }
            Entry::Occupied(slot) => {
                let current = slot.get();
                let next_phase = match &current.phase {
                    PidPhase::AwaitingUserAck => {
                        // Sit tight until the user clicks Let's go.
                        // (Or until the PID disappears — handled below
                        // in the dropped-pids cleanup.)
                        PidPhase::AwaitingUserAck
                    }
                    PidPhase::PreQuit { quit_at } => {
                        let quit_at = *quit_at;
                        if now < quit_at {
                            // Still inside the user's wrap-up window.
                            PidPhase::PreQuit { quit_at }
                        } else {
                            log::info!(
                                "app_watcher: PreQuit elapsed for pid={pid} name='{name}'; sending polite quit"
                            );
                            request_graceful_quit(*pid, &name, proc_);
                            PidPhase::PostQuit { kill_at: now + POSTQUIT_GRACE }
                        }
                    }
                    PidPhase::PostQuit { kill_at } => {
                        let kill_at = *kill_at;
                        if now < kill_at {
                            // Polite quit dispatched; let the save
                            // sheet (if any) play out.
                            PidPhase::PostQuit { kill_at }
                        } else {
                            log::info!(
                                "app_watcher: PostQuit grace elapsed for pid={pid} name='{}'; SIGKILL",
                                current.matched_name
                            );
                            if proc_.kill() {
                                // Mid-block PIDs (warning_raised=false)
                                // never showed a warning; suppress the
                                // hide event for them so the panel-mode
                                // refcount stays balanced with the
                                // shows.
                                if current.warning_raised {
                                    emit_warning_hide(
                                        app,
                                        pid.as_u32(),
                                        &current.matched_name,
                                        HideReason::ForceKilled,
                                    );
                                }
                                slot.remove();
                                continue;
                            }
                            log::warn!(
                                "app_watcher: SIGKILL failed for pid={pid} name='{name}' — will retry"
                            );
                            PidPhase::PostQuit { kill_at }
                        }
                    }
                };
                slot.into_mut().phase = next_phase;
            }
        }
    }

    // PIDs we were tracking that are no longer alive — they exited
    // (cleanly via the user saving + quitting, or via SIGKILL when the
    // PostQuit grace elapsed). Hide any in-flight warning UI for them.
    // Mid-block PIDs (warning_raised=false) get cleaned up silently —
    // they never had a show event, so a hide would unbalance the
    // panel-mode refcount.
    let dropped: Vec<_> = entries
        .keys()
        .filter(|pid| !still_alive.contains(pid))
        .copied()
        .collect();
    for pid in dropped {
        if let Some(entry) = entries.remove(&pid) {
            log::info!(
                "app_watcher: pid={pid} name='{}' is gone",
                entry.matched_name
            );
            if entry.warning_raised {
                emit_warning_hide(app, pid.as_u32(), &entry.matched_name, HideReason::Resolved);
            }
        }
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn sweep(
    _app: Option<&AppHandle>,
    _apps: &BlockedApps,
    _entries: &mut HashMap<u32, PidEntry>,
) {
}

// ---- Graceful quit primitive ----------------------------------------------

/// Send the platform's "Cmd-Q equivalent" — the polite quit primitive
/// that runs the target app's own terminate path, including any
/// unsaved-work prompts. Crucially NOT the same as a POSIX signal:
/// SIGTERM bypasses Cocoa's `applicationShouldTerminate:` and would
/// silently destroy unsaved documents.
/// Polite per-PID quit used by the enforcer as well as this watcher.
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) fn request_graceful_quit(pid: sysinfo::Pid, name: &str, proc_: &sysinfo::Process) {
    request_graceful_quit_impl(pid, name, proc_);
}

#[cfg(target_os = "macos")]
fn request_graceful_quit_impl(pid: sysinfo::Pid, name: &str, proc_: &sysinfo::Process) {
    crate::commands::activate_external_process_by_pid(pid.as_u32());
    // -[NSRunningApplication terminate] sends the AppKit quit Apple
    // Event (`'aevt' 'quit'`) — the same event Cmd-Q dispatches.
    // Available without Automation TCC because we're calling the
    // OS-provided API by PID, not asking another app to run a
    // script. If the lookup fails for some reason (process gone,
    // class missing) we fall back to SIGTERM — still better than
    // SIGKILL, even if it bypasses the save sheet for the few apps
    // that do trap SIGTERM.
    use cocoa::base::{id, BOOL, YES};
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    let raw_pid: i32 = pid.as_u32() as i32;
    unsafe {
        let class = match Class::get("NSRunningApplication") {
            Some(c) => c,
            None => {
                log::warn!(
                    "app_watcher: NSRunningApplication class missing; falling back to SIGTERM for pid={pid} '{name}'"
                );
                let _ = proc_.kill_with(sysinfo::Signal::Term);
                return;
            }
        };
        let app: id = msg_send![class, runningApplicationWithProcessIdentifier: raw_pid];
        if app.is_null() {
            log::warn!(
                "app_watcher: NSRunningApplication lookup returned nil for pid={pid} '{name}'; falling back to SIGTERM"
            );
            let _ = proc_.kill_with(sysinfo::Signal::Term);
            return;
        }
        let ok: BOOL = msg_send![app, terminate];
        if ok != YES {
            log::warn!(
                "app_watcher: -[NSRunningApplication terminate] returned NO for pid={pid} '{name}'; falling back to SIGTERM"
            );
            let _ = proc_.kill_with(sysinfo::Signal::Term);
        }
    }
}

#[cfg(target_os = "windows")]
fn request_graceful_quit_impl(pid: sysinfo::Pid, name: &str, _proc: &sysinfo::Process) {
    crate::commands::activate_external_process_by_pid(pid.as_u32());
    // `taskkill /PID <pid>` (without `/F`) posts WM_CLOSE to the
    // process's top-level windows — the closest Win32 primitive to
    // Cmd-Q. Apps that ask "save changes?" on a normal close get
    // to run that prompt instead of being TerminateProcess-ed
    // mid-write. This is the same primitive `enforcer::quit_browser`
    // uses to politely close non-compliant browsers.
    use crate::windows_process::hidden_command;

    let raw_pid = pid.as_u32().to_string();
    log::info!("app_watcher: taskkill /PID {raw_pid} (graceful close of '{name}')");
    match hidden_command("taskkill").args(["/PID", &raw_pid]).output() {
        Ok(out) => log::debug!(
            "app_watcher: taskkill /PID {raw_pid} -> exit {:?}",
            out.status.code()
        ),
        Err(e) => log::warn!("app_watcher: taskkill /PID {raw_pid} spawn failed: {e}"),
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
#[allow(dead_code)]
fn request_graceful_quit(_pid: sysinfo::Pid, _name: &str, _proc: &sysinfo::Process) {}

/// Mid-block-launch fast path. The user already saw the warning when
/// the block started — opening a blocked app while the block is
/// already running is a deliberate act, so we skip the activation
/// flash + Apple-Event roundtrip that `request_graceful_quit` does and
/// just send SIGTERM directly. Modern Cocoa apps treat SIGTERM as a
/// normal exit (cleanup runs, no UI prompt). Apps that trap SIGTERM
/// still get caught by the 10-second SIGKILL grace.
///
/// On Windows there's no SIGTERM equivalent that's faster than the
/// graceful-close path; we just `proc_.kill()` directly (TerminateProcess)
/// since the user has already opted in by launching the blocked app.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn request_silent_quit(pid: sysinfo::Pid, name: &str, proc_: &sysinfo::Process) {
    log::info!("app_watcher: silent quit pid={pid} name='{name}'");
    match proc_.kill_with(sysinfo::Signal::Term) {
        Some(true) => {}
        Some(false) | None => {
            // SIGTERM dispatch failed (or unsupported, i.e. Windows).
            // Fall straight to TerminateProcess — instant kill.
            let _ = proc_.kill();
        }
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
#[allow(dead_code)]
fn request_silent_quit(_pid: sysinfo::Pid, _name: &str, _proc: &sysinfo::Process) {}

// ---- Imperative actions for the warning modal ---------------------------
//
// The UI sends warned PIDs from the overlay. We optionally foreground
// each in sequence (short pauses between) so stacks of blocked apps are
// visibly cycled, then re-issue one graceful quit per PID.

#[cfg(any(target_os = "macos", target_os = "windows"))]
const ACTIVATION_STAGGER_MS: u64 = 200;

fn dedupe_nonempty_pids(pids: &[u32]) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for &p in pids {
        if p != 0 && seen.insert(p) {
            out.push(p);
        }
    }
    out
}

/// Foreground pass (staggered) then one graceful quit signal per PID.
pub fn user_request_activate_then_polite_quit_round(pids: &[u32]) {
    let uniq = dedupe_nonempty_pids(pids);
    if uniq.is_empty() {
        return;
    }
    log::info!(
        "app_watcher: batch focus then polite quit for {} processes {:?}",
        uniq.len(),
        uniq
    );

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        for (i, pid) in uniq.iter().enumerate() {
            crate::commands::activate_external_process_by_pid(*pid);
            if i + 1 < uniq.len() {
                std::thread::sleep(Duration::from_millis(ACTIVATION_STAGGER_MS));
            }
        }
    }

    polite_quit_for_pid_list(&uniq);
}

fn polite_quit_for_pid_list(pids: &[u32]) {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    for &pid_u in pids {
        let pid_typed = sysinfo::Pid::from_u32(pid_u);
        match sys.process(pid_typed) {
            Some(proc_) => {
                let name = proc_.name().to_string_lossy().to_string();
                log::info!("app_watcher: polite quit pid={pid_u} name='{name}' (batch)");
                request_graceful_quit(pid_typed, &name, proc_);
            }
            None => log::debug!("app_watcher: polite quit skipped — pid={pid_u} not running"),
        }
    }
}
