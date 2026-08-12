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
// `is_protected` keeps us from ever quitting ReDD Blocker, the OS
// loginwindow, Finder, etc.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub type BlockedApps = Arc<RwLock<HashSet<String>>>;

#[cfg(target_os = "macos")]
use crate::window_inventory::user_facing_window_pids;

/// Steady-state poll cadence while a schedule is active but no blocked
/// app is currently being tracked — the common idle case. We only need
/// to notice a newly-launched blocked app within a couple of seconds,
/// so polling slower here roughly halves background CPU/battery cost
/// versus the old fixed 1s sweep.
const POLL_INTERVAL: Duration = Duration::from_millis(2000);
/// Faster cadence while at least one PID is mid-countdown (PreQuit /
/// PostQuit) so the warning overlay and grace timers stay responsive.
const POLL_INTERVAL_ACTIVE: Duration = Duration::from_millis(1000);
/// Safety-net cadence when NSWorkspace launch/activation events are
/// driving wakeups (macOS). Events cover the normal cases — a blocked
/// app launching, a non-allowed app coming frontmost — within
/// milliseconds; this slow sweep only catches what AppKit can't see
/// (raw binaries exec'd outside LaunchServices). Never used while a
/// countdown is in flight.
const EVENTED_SAFETY_NET: Duration = Duration::from_secs(15);

/// Wake handle shared with `workspace_events` (macOS) and `set_policy`:
/// flag + condvar so a wake that lands mid-sweep is never lost.
type WakePair = (Mutex<bool>, Condvar);

/// True when NSWorkspace events are installed and can be trusted to wake
/// the sweep loop; false on Windows and whenever install didn't run —
/// callers then keep the legacy polling cadences.
fn workspace_events_active() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::workspace_events::events_active()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Raise the wake flag and notify — from `set_policy`, `stop`, and (on
/// macOS) NSWorkspace launch/activation/screen-wake notifications.
fn notify_wake(wake: &WakePair) {
    let (flag, cvar) = wake;
    if let Ok(mut raised) = flag.lock() {
        *raised = true;
    }
    cvar.notify_all();
}

/// Sleep until `timeout` elapses or the wake flag is raised, consuming
/// the flag. Spurious sweeps are harmless — sweeps are idempotent.
fn wait_for_wake(wake: &WakePair, timeout: Duration) {
    let (flag, cvar) = wake;
    let Ok(mut raised) = flag.lock() else {
        std::thread::sleep(timeout);
        return;
    };
    let deadline = Instant::now() + timeout;
    while !*raised {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match cvar.wait_timeout(raised, deadline - now) {
            Ok((guard, wait_result)) => {
                raised = guard;
                if wait_result.timed_out() {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    *raised = false;
}

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

/// PIDs currently waiting on the Let's go overlay (`AwaitingUserAck`).
/// Kept separately from the watcher thread's private `entries` map so the
/// frontend can replay any `warning-show` events it missed — Tauri events
/// are fire-and-forget, and on cold start the watcher often emits before
/// JS has called `listen`.
static PENDING_WARNING_ACKS: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();

fn pending_warning_acks_map() -> &'static Mutex<HashMap<u32, String>> {
    PENDING_WARNING_ACKS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn user_acknowledge_warning() {
    USER_ACK_PENDING.store(true, Ordering::SeqCst);
    // Acked PIDs leave the overlay path (PreQuit); drop them from the
    // replay set so a late `list_pending_blocking_warnings` does not
    // re-raise Let's go after the user already clicked through.
    if let Ok(mut map) = pending_warning_acks_map().lock() {
        map.clear();
    }
}

/// Snapshot of PIDs still awaiting Let's go — used to seed the frontend
/// after listeners attach (see `list_pending_blocking_warnings`).
pub fn pending_warning_acks() -> Vec<PendingBlockingWarning> {
    match pending_warning_acks_map().lock() {
        Ok(map) => map
            .iter()
            .map(|(&pid, name)| PendingBlockingWarning {
                pid,
                name: name.clone(),
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn remember_pending_warning_ack(pid: u32, name: &str) {
    if let Ok(mut map) = pending_warning_acks_map().lock() {
        map.insert(pid, name.to_string());
    }
}

fn forget_pending_warning_ack(pid: u32) {
    if let Ok(mut map) = pending_warning_acks_map().lock() {
        map.remove(&pid);
    }
}

const PROTECTED: &[&str] = &[
    "Digital Habits Blocker",
    "Digital Habits: Blocker",
    "ReDD Blocker",
    "Fristed",
    "ReDD Block",
    "redd-block",
    "ReddBlock",
    "System Events",
    "Finder",
    "loginwindow",
    "WindowServer",
    "explorer.exe",
    "dwm.exe",
    "winlogon.exe",
    "svchost.exe",
    "Taskmgr",
    "Task Manager",
];

fn is_protected(name: &str) -> bool {
    is_protected_app_name(name)
}

fn is_self_pid(pid: sysinfo::Pid) -> bool {
    std::process::id() == pid.as_u32()
}

fn is_protected_process(name: &str, pid: sysinfo::Pid) -> bool {
    is_self_pid(pid) || is_protected(name)
}

/// Whether an app label must never be killed by the watcher.
pub fn is_protected_app_name(name: &str) -> bool {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    PROTECTED
        .iter()
        .any(|p| name.eq_ignore_ascii_case(p) || stem.eq_ignore_ascii_case(p))
}

/// Match a running process against a user-facing app label.
/// On macOS the label is usually the `.app` bundle name (e.g.
/// "Android Studio") while `sysinfo` reports the bundle executable
/// (e.g. "studio") — also accept processes whose path lives inside
/// `/Applications/<label>.app/`.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))] // macOS-only branch below
fn process_matches_app_label(
    label: &str,
    proc_name: &str,
    proc_exe: Option<&std::path::Path>,
) -> bool {
    let stem = proc_name.strip_suffix(".exe").unwrap_or(proc_name);
    if label.eq_ignore_ascii_case(proc_name) || label.eq_ignore_ascii_case(stem) {
        return true;
    }
    #[cfg(target_os = "macos")]
    if let Some(exe) = proc_exe {
        let exe_lower = exe.to_string_lossy().to_ascii_lowercase();
        let needle = format!("/{}.app", label.to_ascii_lowercase());
        if exe_lower.contains(&format!("{needle}/")) || exe_lower.ends_with(&needle) {
            return true;
        }
    }
    false
}

fn process_matches_blocked(
    blocked: &str,
    proc_name: &str,
    proc_exe: Option<&std::path::Path>,
) -> bool {
    process_matches_app_label(blocked, proc_name, proc_exe)
}

fn process_is_allowed(
    allowed: &[String],
    proc_name: &str,
    proc_exe: Option<&std::path::Path>,
) -> bool {
    allowed
        .iter()
        .any(|label| process_matches_app_label(label, proc_name, proc_exe))
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
type AllowedApps = Arc<RwLock<HashSet<String>>>;

/// Public handle returned from `start`. Use `set_policy` to update the
/// effective blocked/allowed sets; drop-or-call-`stop` to tear down.
pub struct Handle {
    apps: BlockedApps,
    allowed_apps: AllowedApps,
    allowlist_active: Arc<AtomicBool>,
    allowlist_warn_pending: Arc<AtomicBool>,
    pending_warning_apps: PendingWarningApps,
    stop: Arc<AtomicBool>,
    wake: Arc<WakePair>,
    join: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Handle {
    /// Update blocklist-mode blocked apps and allowlist-mode allowed apps.
    pub fn set_policy(
        &self,
        blocked: Vec<String>,
        newly_added_blocked: Vec<String>,
        allowed: Vec<String>,
        allowlist_active: bool,
        allowlist_newly_started: bool,
    ) {
        // Track whether anything actually changed. The disk-sync loop
        // calls this every 2 s with an unchanged policy in steady state;
        // only real transitions may wake the sweep thread (and produce a
        // log line), otherwise the evented safety-net cadence would
        // degrade right back into 2 s polling.
        let mut changed = false;

        let new_blocked: HashSet<String> =
            blocked.into_iter().filter(|n| !is_protected(n)).collect();
        let new_allowed: HashSet<String> =
            allowed.into_iter().filter(|n| !is_protected(n)).collect();

        if let Ok(mut w) = self.apps.write() {
            if *w != new_blocked {
                changed = true;
                *w = new_blocked;
            }
        }
        if let Ok(mut w) = self.allowed_apps.write() {
            if *w != new_allowed {
                changed = true;
                *w = new_allowed;
            }
        }
        if self
            .allowlist_active
            .swap(allowlist_active, Ordering::SeqCst)
            != allowlist_active
        {
            changed = true;
        }
        if allowlist_newly_started {
            self.allowlist_warn_pending.store(true, Ordering::SeqCst);
            changed = true;
        }
        if !newly_added_blocked.is_empty() {
            if let Ok(mut p) = self.pending_warning_apps.lock() {
                for n in newly_added_blocked {
                    if !is_protected(&n) {
                        changed = true;
                        p.insert(n);
                    }
                }
            }
        }

        if changed {
            log::info!(
                "app_watcher::set_policy: policy changed (allowlist_active={allowlist_active}); waking sweep"
            );
            notify_wake(&self.wake);
        }
    }

    /// Backward-compatible wrapper for blocklist-only updates.
    pub fn set_apps(&self, names: Vec<String>, newly_added: Vec<String>) {
        self.set_policy(names, newly_added, vec![], false, false);
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the sweep thread so the join doesn't block for a full
        // safety-net interval.
        notify_wake(&self.wake);
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

    /// Snapshot of the currently effective allowlist-mode allowed-app set,
    /// sorted alphabetically. Used by diagnostics.
    pub fn current_allowed_apps(&self) -> Vec<String> {
        match self.allowed_apps.read() {
            Ok(h) => {
                let mut v: Vec<String> = h.iter().cloned().collect();
                v.sort();
                v
            }
            Err(_) => Vec::new(),
        }
    }

    /// Whether allowlist-mode app enforcement is active (non-empty allowed set).
    pub fn is_allowlist_active(&self) -> bool {
        self.allowlist_active.load(Ordering::SeqCst)
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
    let allowed_apps: AllowedApps = Arc::new(RwLock::new(HashSet::new()));
    let allowlist_active = Arc::new(AtomicBool::new(false));
    let allowlist_warn_pending = Arc::new(AtomicBool::new(false));
    let pending_warning_apps: PendingWarningApps = Arc::new(Mutex::new(HashSet::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let wake: Arc<WakePair> = Arc::new((Mutex::new(false), Condvar::new()));
    // App launches / activations / screen wakes trip the same condvar
    // the sweep loop sleeps on, so the evented safety-net cadence stays
    // as responsive as the old 1-2 s polling.
    #[cfg(target_os = "macos")]
    crate::workspace_events::add_waker(wake.clone());
    let apps_for_thread = apps.clone();
    let allowed_for_thread = allowed_apps.clone();
    let allowlist_active_for_thread = allowlist_active.clone();
    let allowlist_warn_for_thread = allowlist_warn_pending.clone();
    let pending_for_thread = pending_warning_apps.clone();
    let stop_for_thread = stop.clone();
    let wake_for_thread = wake.clone();
    let join = std::thread::spawn(move || {
        run(
            app,
            apps_for_thread,
            allowed_for_thread,
            allowlist_active_for_thread,
            allowlist_warn_for_thread,
            pending_for_thread,
            stop_for_thread,
            wake_for_thread,
        )
    });
    Handle {
        apps,
        allowed_apps,
        allowlist_active,
        allowlist_warn_pending,
        pending_warning_apps,
        stop,
        wake,
        join: Mutex::new(Some(join)),
    }
}

// ---- Event payloads -------------------------------------------------------

/// Emitted once when a PID transitions into the warning phase.
/// Also returned by [`pending_warning_acks`] for frontend replay.
#[derive(Clone, Debug, Serialize)]
pub struct PendingBlockingWarning {
    pub pid: u32,
    pub name: String,
}

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

/// True while the native watcher considers a blocking warning shell active.
pub fn blocking_warning_shell_active() -> bool {
    BLOCKING_WARNING_LAYERS.load(Ordering::SeqCst) > 0
}

fn emit_warning_show(app: Option<&AppHandle>, pid: u32, name: &str, _total_secs: u64) {
    remember_pending_warning_ack(pid, name);
    blocking_warning_begin(app);
    if let Some(a) = app {
        crate::commands::show_blocking_warning_shell_without_stealing_focus(a);
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
    forget_pending_warning_ack(pid);
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryOrigin {
    Blocklist,
    Allowlist,
}

/// One tick of the per-PID quit state machine, decided purely from the
/// current phase and the clock.
///
/// The side effects (polite quit, SIGKILL, warning teardown) stay with the
/// callers — `sweep` for blocklist-matched PIDs and `advance_pid_entry` for
/// everything else. Both used to carry their own copy of these transitions;
/// routing them through one decision keeps the two paths from drifting and
/// makes the timings assertable without a live process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PidStep {
    /// Stay in the current phase; nothing to do this tick.
    Hold,
    /// PreQuit elapsed — send the polite quit, then enter PostQuit.
    RequestQuit,
    /// PostQuit grace elapsed — SIGKILL.
    ForceKill,
}

fn next_pid_step(phase: &PidPhase, now: Instant) -> PidStep {
    match phase {
        // Sit tight until the user clicks Let's go. (Or until the PID
        // disappears — handled by the dropped-pids cleanup in `sweep`.)
        PidPhase::AwaitingUserAck => PidStep::Hold,
        PidPhase::PreQuit { quit_at } => {
            if now < *quit_at {
                // Still inside the user's wrap-up window.
                PidStep::Hold
            } else {
                PidStep::RequestQuit
            }
        }
        PidPhase::PostQuit { kill_at } => {
            if now < *kill_at {
                // Polite quit dispatched; let the save sheet (if any) play out.
                PidStep::Hold
            } else {
                PidStep::ForceKill
            }
        }
    }
}

/// Sentinel PID for the allowlist block-start overlay when no non-allowed
/// apps need closing — the frontend renders intention-only copy.
#[cfg(any(target_os = "macos", target_os = "windows"))]
const ALLOWLIST_INTENTION_PID_RAW: u32 = 0;
#[cfg(any(target_os = "macos", target_os = "windows"))]
const ALLOWLIST_INTENTION_NAME: &str = "__allowlist_intention__";

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn allowlist_intention_pid() -> sysinfo::Pid {
    sysinfo::Pid::from_u32(ALLOWLIST_INTENTION_PID_RAW)
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
    /// Why this PID was enrolled. Allowlist-origin entries get the
    /// user-facing-window re-check before any quit action; blocklist
    /// entries keep the existing behavior unchanged.
    origin: EntryOrigin,
    /// Allowlist block-start reminder with no apps to close yet. Dismissed
    /// immediately when the user clicks "Let's go!" — no PreQuit countdown.
    intention_only: bool,
}

// ---- Run loop -------------------------------------------------------------

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[allow(clippy::too_many_arguments)] // one sweep call site; splitting the
                                     // signature would only move the argument list somewhere else
fn run(
    app: Option<AppHandle>,
    apps: BlockedApps,
    allowed_apps: AllowedApps,
    allowlist_active: Arc<AtomicBool>,
    allowlist_warn_pending: Arc<AtomicBool>,
    pending_warning_apps: PendingWarningApps,
    stop: Arc<AtomicBool>,
    wake: Arc<WakePair>,
) {
    let mut entries: HashMap<sysinfo::Pid, PidEntry> = HashMap::new();
    let mut sys = sysinfo::System::new();
    while !stop.load(Ordering::SeqCst) {
        sweep(
            app.as_ref(),
            &apps,
            &allowed_apps,
            &allowlist_active,
            &allowlist_warn_pending,
            &pending_warning_apps,
            &mut entries,
            &mut sys,
        );
        // Poll fast while a countdown is in flight, or while an allowlist
        // block-start sweep is pending so visible apps behind ReDD Blocker
        // are caught within ~500ms instead of the idle cadence.
        //
        // Idle cadence: with NSWorkspace events active (macOS), app
        // launches / activations / policy changes wake the condvar
        // directly, so the timed sweep is only a safety net for
        // processes AppKit doesn't announce — it runs at
        // EVENTED_SAFETY_NET instead of 1-2 s. Without events (Windows,
        // or install failure) the legacy polling cadences apply.
        let evented = workspace_events_active();
        let interval = if !entries.is_empty() {
            POLL_INTERVAL_ACTIVE
        } else if allowlist_warn_pending.load(Ordering::SeqCst) {
            Duration::from_millis(500)
        } else if evented {
            EVENTED_SAFETY_NET
        } else if allowlist_active.load(Ordering::SeqCst) {
            POLL_INTERVAL_ACTIVE
        } else {
            POLL_INTERVAL
        };
        wait_for_wake(&wake, interval);
    }
    // On stop: clear any in-flight warnings so the UI doesn't keep
    // showing a stale modal after the watcher's gone. Mid-block PIDs
    // (warning_raised=false) never emitted a show, so they don't
    // emit a hide either — keeps the panel-mode refcount balanced.
    for (pid, entry) in entries.drain() {
        if entry.warning_raised {
            emit_warning_hide(
                app.as_ref(),
                pid.as_u32(),
                &entry.matched_name,
                HideReason::Resolved,
            );
        }
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn run(
    _app: Option<AppHandle>,
    _apps: BlockedApps,
    _allowed_apps: AllowedApps,
    _allowlist_active: Arc<AtomicBool>,
    _allowlist_warn_pending: Arc<AtomicBool>,
    _pending_warning_apps: PendingWarningApps,
    _stop: Arc<AtomicBool>,
    _wake: Arc<WakePair>,
) {
    // Linux has no in-process watcher; blocking apps would need a
    // distro-specific approach (e.g. cgroup freezer) — out of scope.
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[allow(clippy::too_many_arguments)] // one sweep call site; splitting the
                                     // signature would only move the argument list somewhere else
fn sweep(
    app: Option<&AppHandle>,
    apps: &BlockedApps,
    allowed_apps: &AllowedApps,
    allowlist_active: &AtomicBool,
    allowlist_warn_pending: &AtomicBool,
    pending_warning_apps: &PendingWarningApps,
    entries: &mut HashMap<sysinfo::Pid, PidEntry>,
    sys: &mut sysinfo::System,
) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};

    let blocked: Vec<String> = match apps.read() {
        Ok(g) => g.iter().cloned().collect(),
        Err(_) => return,
    };
    let allowed: Vec<String> = match allowed_apps.read() {
        Ok(g) => g.iter().cloned().collect(),
        Err(_) => return,
    };
    let allowlist_on = allowlist_active.load(Ordering::SeqCst);

    // One-shot snapshot — the names in here are eligible for the
    // AwaitingUserAck warning on this sweep's first-sighting. Drained
    // so subsequent sweeps see an empty set and route mid-block app
    // launches straight to the silent Cmd-Q path.
    let pending_warn: HashSet<String> = match pending_warning_apps.lock() {
        Ok(mut p) => p.drain().collect(),
        Err(_) => HashSet::new(),
    };
    if blocked.is_empty() && !allowlist_on {
        if !entries.is_empty() {
            for (pid, entry) in entries.drain() {
                if entry.warning_raised {
                    emit_warning_hide(app, pid.as_u32(), &entry.matched_name, HideReason::Resolved);
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
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let allowlist_window_pids = if allowlist_on && !allowed.is_empty() {
        Some(current_user_facing_window_pids())
    } else {
        None
    };

    // If the user clicked "Let's go!" since the last sweep, transition
    // every PID currently in `AwaitingUserAck` into `PreQuit`. Atomic
    // swap so we consume the signal exactly once.
    let user_acked = USER_ACK_PENDING.swap(false, Ordering::SeqCst);
    if user_acked {
        let mut intention_dismissed: Vec<sysinfo::Pid> = Vec::new();
        for (pid, entry) in entries.iter_mut() {
            if !matches!(entry.phase, PidPhase::AwaitingUserAck) {
                continue;
            }
            if entry.intention_only {
                intention_dismissed.push(*pid);
                continue;
            }
            log::info!(
                "app_watcher: user ack received for '{}'; entering PreQuit",
                entry.matched_name
            );
            entry.phase = PidPhase::PreQuit {
                quit_at: now + PREQUIT_DURATION,
            };
        }
        for pid in intention_dismissed {
            if let Some(entry) = entries.remove(&pid) {
                log::info!(
                    "app_watcher: allowlist intention ack for pid={pid} name='{}'",
                    entry.matched_name
                );
                if entry.warning_raised {
                    emit_warning_hide(app, pid.as_u32(), &entry.matched_name, HideReason::Resolved);
                }
            }
        }
    }

    let mut blocklist_matched: HashSet<sysinfo::Pid> = HashSet::new();

    for (pid, proc_) in sys.processes() {
        let name = proc_.name().to_string_lossy().to_string();
        if name.is_empty() || is_protected_process(&name, *pid) {
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
        blocklist_matched.insert(*pid);

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
                    emit_warning_show(app, pid.as_u32(), &matched_name, PREQUIT_DURATION.as_secs());
                    slot.insert(PidEntry {
                        matched_name,
                        phase: PidPhase::AwaitingUserAck,
                        warning_raised: true,
                        origin: EntryOrigin::Blocklist,
                        intention_only: false,
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
                        phase: PidPhase::PostQuit {
                            kill_at: now + POSTQUIT_GRACE,
                        },
                        warning_raised: false,
                        origin: EntryOrigin::Blocklist,
                        intention_only: false,
                    });
                }
            }
            Entry::Occupied(mut slot) => match next_pid_step(&slot.get().phase, now) {
                PidStep::Hold => {}
                PidStep::RequestQuit => {
                    log::info!(
                        "app_watcher: PreQuit elapsed for pid={pid} name='{name}'; sending polite quit"
                    );
                    request_graceful_quit(*pid, &name, proc_);
                    slot.get_mut().phase = PidPhase::PostQuit {
                        kill_at: now + POSTQUIT_GRACE,
                    };
                }
                PidStep::ForceKill => {
                    let matched_name = slot.get().matched_name.clone();
                    let warning_raised = slot.get().warning_raised;
                    log::info!(
                        "app_watcher: PostQuit grace elapsed for pid={pid} name='{matched_name}'; SIGKILL"
                    );
                    if proc_.kill() {
                        // Mid-block PIDs (warning_raised=false) never showed a
                        // warning; suppress the hide event for them so the
                        // panel-mode refcount stays balanced with the shows.
                        if warning_raised {
                            emit_warning_hide(
                                app,
                                pid.as_u32(),
                                &matched_name,
                                HideReason::ForceKilled,
                            );
                        }
                        slot.remove();
                        continue;
                    }
                    log::warn!(
                        "app_watcher: SIGKILL failed for pid={pid} name='{name}' — will retry"
                    );
                    // Phase unchanged: retry on the next tick.
                }
            },
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if allowlist_on && !allowed.is_empty() {
        sweep_allowlist(
            app,
            &allowed,
            allowlist_warn_pending,
            entries,
            sys,
            now,
            &mut still_alive,
            allowlist_window_pids.as_ref(),
        );
    }

    // Advance in-flight allowlist (and any other non-blocklist) entries even
    // when they are no longer frontmost — otherwise switching away aborts
    // a polite-quit / SIGKILL timer mid-flight.
    let tracked: Vec<sysinfo::Pid> = entries.keys().copied().collect();
    for pid in tracked {
        if blocklist_matched.contains(&pid) {
            continue;
        }
        let Some(proc_) = sys.process(pid) else {
            continue;
        };
        still_alive.insert(pid);
        let name = proc_.name().to_string_lossy().to_string();
        if let Some(entry) = entries.get_mut(&pid) {
            let matched = entry.matched_name.clone();
            let warned = entry.warning_raised;
            let origin = entry.origin;
            let intention_only = entry.intention_only;
            if advance_pid_entry(
                app,
                pid,
                &name,
                proc_,
                &mut entry.phase,
                &matched,
                warned,
                origin,
                intention_only,
                now,
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                allowlist_window_pids.as_ref(),
            ) {
                entries.remove(&pid);
            }
        }
    }

    // Allowlist block-start with no apps to close uses a sentinel PID, not a
    // real process — keep it off the "process is gone" cleanup path until ack.
    for (pid, entry) in entries.iter() {
        if entry.intention_only && matches!(entry.phase, PidPhase::AwaitingUserAck) {
            still_alive.insert(*pid);
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

/// Advance a tracked PID one step through the quit state machine.
/// Returns `true` when the entry should be removed (SIGKILL completed).
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[allow(clippy::too_many_arguments)] // one sweep call site; splitting the
                                     // signature would only move the argument list somewhere else
fn advance_pid_entry(
    app: Option<&AppHandle>,
    pid: sysinfo::Pid,
    proc_name: &str,
    proc_: &sysinfo::Process,
    phase: &mut PidPhase,
    matched_name: &str,
    warning_raised: bool,
    origin: EntryOrigin,
    intention_only: bool,
    now: Instant,
    #[cfg(any(target_os = "macos", target_os = "windows"))] allowlist_window_pids: Option<
        &HashSet<u32>,
    >,
) -> bool {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    if origin == EntryOrigin::Allowlist
        && !intention_only
        && !allowlist_entry_still_user_facing(pid, allowlist_window_pids)
    {
        if warning_raised {
            emit_warning_hide(app, pid.as_u32(), matched_name, HideReason::Resolved);
        }
        return true;
    }

    match next_pid_step(phase, now) {
        PidStep::Hold => {}
        PidStep::RequestQuit => {
            log::info!(
                "app_watcher: PreQuit elapsed for pid={pid} name='{proc_name}'; sending polite quit"
            );
            request_graceful_quit(pid, proc_name, proc_);
            *phase = PidPhase::PostQuit {
                kill_at: now + POSTQUIT_GRACE,
            };
        }
        PidStep::ForceKill => {
            log::info!(
                "app_watcher: PostQuit grace elapsed for pid={pid} name='{proc_name}'; SIGKILL"
            );
            if proc_.kill() {
                if warning_raised {
                    emit_warning_hide(app, pid.as_u32(), matched_name, HideReason::ForceKilled);
                }
                return true;
            }
            log::warn!("app_watcher: SIGKILL failed for pid={pid} name='{proc_name}' — will retry");
            // Phase unchanged: retry on the next tick.
        }
    }
    false
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn refresh_pid(sys: &mut sysinfo::System, pid: sysinfo::Pid) {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
}

/// Allowlist enforcement. On block start (`allowlist_warn_pending`) every
/// visible regular app is checked so apps left open behind ReDD Blocker
/// still get closed. **Every** visible non-allowed app gets the user-ack
/// warning on that one sweep — not just the first. After that, only the
/// frontmost app is checked so background agents (Dropbox, etc.) keep running.
#[cfg(any(target_os = "macos", target_os = "windows"))]
#[allow(clippy::too_many_arguments)] // one sweep call site; splitting the
                                     // signature would only move the argument list somewhere else
fn sweep_allowlist(
    app: Option<&AppHandle>,
    allowed: &[String],
    allowlist_warn_pending: &AtomicBool,
    entries: &mut HashMap<sysinfo::Pid, PidEntry>,
    sys: &mut sysinfo::System,
    now: Instant,
    still_alive: &mut HashSet<sysinfo::Pid>,
    allowlist_window_pids: Option<&HashSet<u32>>,
) {
    let block_start = allowlist_warn_pending.load(Ordering::SeqCst);
    let targets = if block_start {
        visible_non_allowed_regular_apps(allowed)
    } else {
        frontmost_non_allowed_app(allowed)
    };

    if !block_start && targets.is_empty() {
        return;
    }

    // One-shot: the very next sweep after `set_policy(..., allowlist_newly_started)`
    // scans every visible non-allowed app. All of them get the user-ack warning —
    // never silent quit on the same tick (mid-block frontmost violations only).
    let block_start_batch = block_start;
    if block_start {
        allowlist_warn_pending.store(false, Ordering::SeqCst);
    }

    let mut block_start_warning_raised = false;

    for (pid, proc_name, display_name) in targets {
        if is_protected_process(&proc_name, pid) {
            continue;
        }
        if !allowlist_entry_still_user_facing(pid, allowlist_window_pids) {
            continue;
        }
        refresh_pid(sys, pid);
        let proc_exe = sys
            .process(pid)
            .and_then(|p| p.exe().map(|p| p.to_path_buf()));
        if process_is_allowed(allowed, &proc_name, proc_exe.as_deref()) {
            continue;
        }
        let Some(proc_) = sys.process(pid) else {
            log::debug!(
                "app_watcher: allowlist skip pid={pid} name='{proc_name}' — not in process table"
            );
            continue;
        };

        still_alive.insert(pid);

        match entries.entry(pid) {
            Entry::Vacant(slot) => {
                if block_start_batch {
                    log::info!(
                        "app_watcher: allowlist block-start pid={pid} name='{proc_name}'; raising user-ack warning"
                    );
                    emit_warning_show(app, pid.as_u32(), &display_name, PREQUIT_DURATION.as_secs());
                    block_start_warning_raised = true;
                    slot.insert(PidEntry {
                        matched_name: display_name.clone(),
                        phase: PidPhase::AwaitingUserAck,
                        warning_raised: true,
                        origin: EntryOrigin::Allowlist,
                        intention_only: false,
                    });
                } else {
                    log::info!(
                        "app_watcher: allowlist sighting pid={pid} name='{proc_name}'; silent quit"
                    );
                    request_silent_quit(pid, &proc_name, proc_);
                    slot.insert(PidEntry {
                        matched_name: display_name,
                        phase: PidPhase::PostQuit {
                            kill_at: now + POSTQUIT_GRACE,
                        },
                        warning_raised: false,
                        origin: EntryOrigin::Allowlist,
                        intention_only: false,
                    });
                }
            }
            Entry::Occupied(_) => {}
        }
    }

    if block_start_batch && !block_start_warning_raised {
        raise_allowlist_intention_warning(app, entries);
        still_alive.insert(allowlist_intention_pid());
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn raise_allowlist_intention_warning(
    app: Option<&AppHandle>,
    entries: &mut HashMap<sysinfo::Pid, PidEntry>,
) {
    if entries.contains_key(&allowlist_intention_pid()) {
        return;
    }
    log::info!(
        "app_watcher: allowlist block-start with no closable apps; raising intention warning"
    );
    emit_warning_show(
        app,
        ALLOWLIST_INTENTION_PID_RAW,
        ALLOWLIST_INTENTION_NAME,
        PREQUIT_DURATION.as_secs(),
    );
    entries.insert(
        allowlist_intention_pid(),
        PidEntry {
            matched_name: ALLOWLIST_INTENTION_NAME.to_string(),
            phase: PidPhase::AwaitingUserAck,
            warning_raised: true,
            origin: EntryOrigin::Allowlist,
            intention_only: true,
        },
    );
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn frontmost_non_allowed_app(_allowed: &[String]) -> Vec<(sysinfo::Pid, String, String)> {
    let Some((pid, proc_name, display_name)) = frontmost_app_pid_and_name() else {
        return Vec::new();
    };
    if proc_name.is_empty() || is_protected_process(&proc_name, pid) {
        return Vec::new();
    }
    vec![(pid, proc_name, display_name)]
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn visible_non_allowed_regular_apps(allowed: &[String]) -> Vec<(sysinfo::Pid, String, String)> {
    let mut out = Vec::new();
    for (pid, proc_name, display_name, bundle_path) in visible_regular_running_apps() {
        if is_protected_process(&proc_name, pid) {
            continue;
        }
        let bundle_ref = bundle_path.as_deref();
        if allowed
            .iter()
            .any(|label| process_matches_app_label(label, &proc_name, bundle_ref))
        {
            continue;
        }
        out.push((pid, proc_name, display_name));
    }
    out
}

/// User-facing apps/windows that count as closable allowlist targets.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
fn visible_regular_running_apps() -> Vec<(sysinfo::Pid, String, String, Option<std::path::PathBuf>)>
{
    use cocoa::base::{id, YES};
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let ws_class = match Class::get("NSWorkspace") {
            Some(c) => c,
            None => return Vec::new(),
        };
        let ws: id = msg_send![ws_class, sharedWorkspace];
        let apps: id = msg_send![ws, runningApplications];
        if apps.is_null() {
            return Vec::new();
        }
        let count: usize = msg_send![apps, count];
        let mut out = Vec::new();
        for i in 0..count {
            let app: id = msg_send![apps, objectAtIndex: i];
            if app.is_null() {
                continue;
            }
            // NSApplicationActivationPolicyRegular == 0
            let policy: i64 = msg_send![app, activationPolicy];
            if policy != 0 {
                continue;
            }
            let hidden: cocoa::base::BOOL = msg_send![app, isHidden];
            if hidden == YES {
                continue;
            }
            let raw_pid: i32 = msg_send![app, processIdentifier];
            if raw_pid <= 0 {
                continue;
            }
            let name: id = msg_send![app, localizedName];
            if name.is_null() {
                continue;
            }
            let cstr: *const i8 = msg_send![name, UTF8String];
            if cstr.is_null() {
                continue;
            }
            let name_str = std::ffi::CStr::from_ptr(cstr)
                .to_string_lossy()
                .into_owned();
            let bundle: id = msg_send![app, bundleURL];
            let bundle_path = if bundle.is_null() {
                None
            } else {
                let path: id = msg_send![bundle, path];
                if path.is_null() {
                    None
                } else {
                    let p: *const i8 = msg_send![path, UTF8String];
                    if p.is_null() {
                        None
                    } else {
                        Some(std::path::PathBuf::from(
                            std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned(),
                        ))
                    }
                }
            };
            out.push((
                sysinfo::Pid::from_u32(raw_pid as u32),
                name_str.clone(),
                name_str,
                bundle_path,
            ));
        }
        out
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct UserFacingWindow {
    pid: u32,
    title: String,
    class_name: String,
}

#[cfg(target_os = "windows")]
const MIN_USER_WINDOW_EDGE_PX: i32 = 80;

#[cfg(target_os = "windows")]
fn humanize_windows_process_name(proc_name: &str) -> String {
    let raw = proc_name
        .trim()
        .strip_suffix(".exe")
        .unwrap_or(proc_name.trim());
    let spaced = raw
        .replace(['_', '-'], " ")
        .chars()
        .enumerate()
        .flat_map(|(idx, ch)| {
            if idx > 0 && ch.is_ascii_uppercase() {
                vec![' ', ch]
            } else {
                vec![ch]
            }
        })
        .collect::<String>();
    let normalized = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        proc_name.to_string()
    } else {
        normalized
    }
}

#[cfg(target_os = "windows")]
fn display_name_from_window_title(title: &str, proc_name: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return humanize_windows_process_name(proc_name);
    }

    for sep in [" - ", " — ", " – ", " | "] {
        if let Some((_, tail)) = trimmed.rsplit_once(sep) {
            let tail = tail.trim();
            if !tail.is_empty() && tail.len() <= 64 {
                return tail.to_string();
            }
        }
    }

    trimmed.to_string()
}

#[cfg(target_os = "windows")]
fn is_windows_shell_input_surface(class_name: &str, proc_path: Option<&std::path::Path>) -> bool {
    let Some(path) = proc_path.and_then(|p| p.to_str()) else {
        return false;
    };
    let path_lower = path.to_ascii_lowercase();
    path_lower.contains("\\windows\\systemapps\\")
        && class_name.eq_ignore_ascii_case("Windows.UI.Core.CoreWindow")
}

/// DWM-cloaked windows report `IsWindowVisible` but are hidden from the
/// user (background UWP hosts like Realtek Audio Console, shell surfaces).
#[cfg(target_os = "windows")]
fn is_windows_cloaked_window(hwnd: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};

    let mut cloaked = 0u32;
    unsafe {
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        )
        .is_err()
        {
            return false;
        }
    }
    cloaked != 0
}

#[cfg(target_os = "windows")]
fn collect_user_facing_windows() -> Vec<UserFacingWindow> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_OWNER,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    struct CollectCtx {
        windows: Vec<UserFacingWindow>,
    }

    unsafe extern "system" fn collect_top_level(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut CollectCtx);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        if is_windows_cloaked_window(hwnd) {
            return BOOL(1);
        }
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if owner != HWND::default() {
            return BOOL(1);
        }

        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if (ex_style & WS_EX_TOOLWINDOW.0) != 0 || (ex_style & WS_EX_NOACTIVATE.0) != 0 {
            return BOOL(1);
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if !IsIconic(hwnd).as_bool()
            && (width < MIN_USER_WINDOW_EDGE_PX || height < MIN_USER_WINDOW_EDGE_PX)
        {
            return BOOL(1);
        }

        let title_len = GetWindowTextLengthW(hwnd);
        if title_len <= 0 {
            return BOOL(1);
        }
        let mut title_buf = vec![0u16; title_len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut title_buf);
        if copied <= 0 {
            return BOOL(1);
        }
        let title = String::from_utf16_lossy(&title_buf[..copied as usize])
            .trim()
            .to_string();
        if title.is_empty() {
            return BOOL(1);
        }
        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        let class_name = if class_len > 0 {
            String::from_utf16_lossy(&class_buf[..class_len as usize])
        } else {
            String::new()
        };

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return BOOL(1);
        }

        ctx.windows.push(UserFacingWindow {
            pid,
            title,
            class_name,
        });
        BOOL(1)
    }

    let mut ctx = CollectCtx {
        windows: Vec::new(),
    };
    unsafe {
        let ptr = (&mut ctx) as *mut CollectCtx as isize;
        let _ = EnumWindows(Some(collect_top_level), LPARAM(ptr));
    }
    ctx.windows
}

#[cfg(target_os = "windows")]
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
fn visible_regular_running_apps() -> Vec<(sysinfo::Pid, String, String, Option<std::path::PathBuf>)>
{
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let windows = collect_user_facing_windows();
    if windows.is_empty() {
        return Vec::new();
    }

    let mut window_meta_by_pid: HashMap<u32, (String, String)> = HashMap::new();
    let mut pids: Vec<sysinfo::Pid> = Vec::new();
    for window in &windows {
        window_meta_by_pid
            .entry(window.pid)
            .or_insert_with(|| (window.title.clone(), window.class_name.clone()));
    }
    for pid in window_meta_by_pid.keys().copied() {
        pids.push(sysinfo::Pid::from_u32(pid));
    }
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );

    let mut out = Vec::new();
    for pid in pids {
        let Some(proc_) = sys.process(pid) else {
            continue;
        };
        let proc_name = proc_.name().to_string_lossy().to_string();
        if proc_name.is_empty() || is_protected_process(&proc_name, pid) {
            continue;
        }
        let proc_path = proc_.exe().map(|p| p.to_path_buf());
        let (title, class_name) = match window_meta_by_pid.get(&pid.as_u32()) {
            Some(meta) => meta,
            None => continue,
        };
        if is_windows_shell_input_surface(class_name, proc_path.as_deref()) {
            continue;
        }
        let display_name = display_name_from_window_title(title, &proc_name);
        out.push((pid, proc_name, display_name, proc_path));
    }
    out
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
fn frontmost_app_pid_and_name() -> Option<(sysinfo::Pid, String, String)> {
    use cocoa::base::id;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let ws_class = Class::get("NSWorkspace")?;
        let ws: id = msg_send![ws_class, sharedWorkspace];
        let front: id = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return None;
        }
        let raw_pid: i32 = msg_send![front, processIdentifier];
        if raw_pid <= 0 {
            return None;
        }
        let name: id = msg_send![front, localizedName];
        if name.is_null() {
            return None;
        }
        let cstr: *const i8 = msg_send![name, UTF8String];
        if cstr.is_null() {
            return None;
        }
        let name_str = std::ffi::CStr::from_ptr(cstr)
            .to_string_lossy()
            .into_owned();
        Some((
            sysinfo::Pid::from_u32(raw_pid as u32),
            name_str.clone(),
            name_str,
        ))
    }
}

#[cfg(target_os = "windows")]
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
fn frontmost_app_pid_and_name() -> Option<(sysinfo::Pid, String, String)> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == HWND::default() {
        return None;
    }

    let allowed_pids = current_user_facing_window_pids();

    let mut raw_pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut raw_pid));
    }
    if raw_pid == 0 || !allowed_pids.contains(&raw_pid) {
        return None;
    }

    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    let mut title = String::new();
    if title_len > 0 {
        let mut title_buf = vec![0u16; title_len as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
        if copied > 0 {
            title = String::from_utf16_lossy(&title_buf[..copied as usize])
                .trim()
                .to_string();
        }
    }

    let pid = sysinfo::Pid::from_u32(raw_pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    let proc_ = sys.process(pid)?;
    let proc_name = proc_.name().to_string_lossy().to_string();
    if proc_name.is_empty() || is_protected_process(&proc_name, pid) {
        return None;
    }
    let proc_path = proc_.exe().map(|p| p.to_path_buf());
    let class_name = {
        let mut buf = [0u16; 512];
        let copied =
            unsafe { windows::Win32::UI::WindowsAndMessaging::GetClassNameW(hwnd, &mut buf) };
        if copied > 0 {
            String::from_utf16_lossy(&buf[..copied as usize])
        } else {
            String::new()
        }
    };
    if is_windows_shell_input_surface(&class_name, proc_path.as_deref()) {
        return None;
    }
    let display_name = display_name_from_window_title(&title, &proc_name);
    Some((pid, proc_name, display_name))
}

#[cfg(target_os = "macos")]
fn current_user_facing_window_pids() -> HashSet<u32> {
    user_facing_window_pids()
}

#[cfg(target_os = "windows")]
fn current_user_facing_window_pids() -> HashSet<u32> {
    collect_user_facing_windows()
        .into_iter()
        .map(|window| window.pid)
        .collect()
}

#[cfg(target_os = "windows")]
fn allowlist_entry_still_user_facing(
    pid: sysinfo::Pid,
    allowlist_window_pids: Option<&HashSet<u32>>,
) -> bool {
    let Some(window_pids) = allowlist_window_pids else {
        return false;
    };
    window_pids.contains(&pid.as_u32())
}

#[cfg(target_os = "macos")]
fn allowlist_entry_still_user_facing(
    pid: sysinfo::Pid,
    allowlist_window_pids: Option<&HashSet<u32>>,
) -> bool {
    let Some(window_pids) = allowlist_window_pids else {
        return false;
    };
    window_pids.contains(&pid.as_u32()) && pid_has_regular_activation_policy(pid)
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
fn pid_has_regular_activation_policy(pid: sysinfo::Pid) -> bool {
    use cocoa::base::id;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    let raw_pid: i32 = pid.as_u32() as i32;
    unsafe {
        let Some(class) = Class::get("NSRunningApplication") else {
            return false;
        };
        let app: id = msg_send![class, runningApplicationWithProcessIdentifier: raw_pid];
        if app.is_null() {
            return false;
        }
        let policy: i64 = msg_send![app, activationPolicy];
        policy == 0
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn sweep(
    _app: Option<&AppHandle>,
    _apps: &BlockedApps,
    _allowed_apps: &AllowedApps,
    _allowlist_active: &AtomicBool,
    _allowlist_warn_pending: &AtomicBool,
    _pending_warning_apps: &PendingWarningApps,
    _entries: &mut HashMap<sysinfo::Pid, PidEntry>,
    _sys: &mut sysinfo::System,
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
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
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
#[allow(deprecated)] // cocoa crate; objc2 migration is separate work
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

#[cfg(test)]
mod tests {
    use super::*;

    // The watcher's two dangerous behaviours are "force-quits the wrong
    // process" and "force-quits the right process too early". Both are
    // decided by pure functions — the protection list, the label matcher,
    // and the phase machine — so they are asserted here directly.
    //
    // Not covered at this layer: `sweep` itself, which needs a live
    // `sysinfo::Process` to enrol a PID and to call `kill()`. The enrolment
    // rules (warning-eligible first sighting vs. silent mid-block PostQuit)
    // stay with the manual checklist.

    // ---- protection list --------------------------------------------

    #[test]
    fn protected_names_are_never_targets() {
        // Quitting any of these would either kill the blocker itself —
        // the one process that must survive to keep enforcing — or take
        // the desktop down with it.
        for name in [
            "Digital Habits Blocker",
            "Digital Habits: Blocker",
            "ReDD Blocker",
            "redd-block",
            "Finder",
            "loginwindow",
            "WindowServer",
            "explorer.exe",
            "dwm.exe",
            "winlogon.exe",
        ] {
            assert!(is_protected_app_name(name), "{name} must be protected");
        }
    }

    #[test]
    fn protection_ignores_case_and_the_exe_suffix() {
        assert!(is_protected_app_name("finder"));
        assert!(is_protected_app_name("FINDER"));
        assert!(is_protected_app_name("EXPLORER.EXE"));
        // "Taskmgr" is listed without a suffix; the Windows process carries one.
        assert!(is_protected_app_name("Taskmgr.exe"));
        assert!(is_protected_app_name("Task Manager"));
    }

    #[test]
    fn ordinary_apps_are_not_protected() {
        // An over-broad protection rule silently exempts apps the user
        // asked to block, which reads as "blocking is broken".
        for name in [
            "Safari",
            "Slack",
            "Microsoft Word",
            "Finder Helper",
            "MyWindowServerThing",
            "chrome.exe",
        ] {
            assert!(!is_protected_app_name(name), "{name} must not be protected");
        }
    }

    // ---- label matching ---------------------------------------------

    #[test]
    fn label_matches_process_name_case_insensitively() {
        assert!(process_matches_app_label("Slack", "Slack", None));
        assert!(process_matches_app_label("slack", "Slack", None));
        assert!(process_matches_app_label("Chrome", "chrome.exe", None));
    }

    #[test]
    fn label_does_not_match_a_different_app_with_a_shared_prefix() {
        // Substring matching here would quit apps the user never listed.
        assert!(!process_matches_app_label("Slack", "Slackbot", None));
        assert!(!process_matches_app_label("Code", "Codex", None));
        assert!(!process_matches_app_label("Mail", "Mailspring", None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn label_matches_the_bundle_directory_when_the_executable_differs() {
        // sysinfo reports the bundle executable ("studio"), the user's list
        // holds the bundle name ("Android Studio") — without the path check
        // the app is simply never matched and never blocked.
        let exe = std::path::Path::new("/Applications/Android Studio.app/Contents/MacOS/studio");
        assert!(process_matches_app_label(
            "Android Studio",
            "studio",
            Some(exe)
        ));
        assert!(!process_matches_app_label("Xcode", "studio", Some(exe)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bundle_path_match_does_not_fire_on_a_longer_bundle_name() {
        let exe = std::path::Path::new("/Applications/Codex.app/Contents/MacOS/Codex");
        assert!(!process_matches_app_label("Code", "Codex", Some(exe)));
    }

    #[test]
    fn allow_check_spans_the_whole_allowed_list() {
        let allowed = vec!["Safari".to_string(), "Notes".to_string()];
        assert!(process_is_allowed(&allowed, "Notes", None));
        assert!(!process_is_allowed(&allowed, "Slack", None));
        assert!(!process_is_allowed(&[], "Notes", None));
    }

    // ---- phase machine ----------------------------------------------

    #[test]
    fn awaiting_ack_never_advances_on_its_own() {
        // The Let's go overlay must wait for the user however long it takes;
        // an elapsed timer here would quit an app with no warning shown.
        let now = Instant::now();
        assert_eq!(
            next_pid_step(&PidPhase::AwaitingUserAck, now),
            PidStep::Hold
        );
        assert_eq!(
            next_pid_step(&PidPhase::AwaitingUserAck, now + Duration::from_secs(3600)),
            PidStep::Hold
        );
    }

    #[test]
    fn prequit_holds_until_its_deadline_then_asks_for_a_polite_quit() {
        let now = Instant::now();
        let phase = PidPhase::PreQuit {
            quit_at: now + PREQUIT_DURATION,
        };
        assert_eq!(next_pid_step(&phase, now), PidStep::Hold);
        assert_eq!(
            next_pid_step(&phase, now + PREQUIT_DURATION - Duration::from_millis(1)),
            PidStep::Hold
        );
        // The deadline itself fires — `now < quit_at` is the hold condition.
        assert_eq!(
            next_pid_step(&phase, now + PREQUIT_DURATION),
            PidStep::RequestQuit
        );
    }

    #[test]
    fn postquit_holds_through_the_grace_then_force_kills() {
        let now = Instant::now();
        let phase = PidPhase::PostQuit {
            kill_at: now + POSTQUIT_GRACE,
        };
        assert_eq!(next_pid_step(&phase, now), PidStep::Hold);
        assert_eq!(
            next_pid_step(&phase, now + POSTQUIT_GRACE - Duration::from_millis(1)),
            PidStep::Hold
        );
        assert_eq!(
            next_pid_step(&phase, now + POSTQUIT_GRACE),
            PidStep::ForceKill
        );
    }

    #[test]
    fn the_full_sequence_gives_the_user_both_grace_windows() {
        // Walk warn -> polite quit -> SIGKILL the way a sweep would, and
        // check nothing escalates early. Shortening either window is a
        // user-visible regression (an app killed mid-save).
        let start = Instant::now();
        let mut phase = PidPhase::AwaitingUserAck;

        // User clicks "Let's go!" — `sweep` performs this transition.
        phase = PidPhase::PreQuit {
            quit_at: start + PREQUIT_DURATION,
        };

        let mut t = start;
        while t < start + PREQUIT_DURATION {
            assert_eq!(
                next_pid_step(&phase, t),
                PidStep::Hold,
                "early quit at {t:?}"
            );
            t += Duration::from_secs(1);
        }
        let quit_at = start + PREQUIT_DURATION;
        assert_eq!(next_pid_step(&phase, quit_at), PidStep::RequestQuit);

        phase = PidPhase::PostQuit {
            kill_at: quit_at + POSTQUIT_GRACE,
        };
        let mut t = quit_at;
        while t < quit_at + POSTQUIT_GRACE {
            assert_eq!(
                next_pid_step(&phase, t),
                PidStep::Hold,
                "early kill at {t:?}"
            );
            t += Duration::from_secs(1);
        }
        assert_eq!(
            next_pid_step(&phase, quit_at + POSTQUIT_GRACE),
            PidStep::ForceKill
        );
    }

    #[test]
    fn grace_windows_are_long_enough_to_be_usable() {
        // Guards against a zero/near-zero constant slipping in: the whole
        // point of the state machine is that the user gets time to save.
        assert!(PREQUIT_DURATION >= Duration::from_secs(10));
        assert!(POSTQUIT_GRACE >= Duration::from_secs(5));
    }
}
