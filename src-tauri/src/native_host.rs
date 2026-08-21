// Native-messaging host mode for the ReDD Focus browser extension.
//
// The main binary is registered as the native-messaging host for the
// patched ReDD Focus extension on Chrome / Brave / Edge / Firefox (and
// on macOS, the Safari extension uses SafariWebExtensionHandler.swift
// directly — this file is not involved there).
//
// When the browser spawns this binary, it passes arguments like
// `--native-host chrome-extension://<id>/` (Chromium) or the extension
// id (Firefox). We detect the flag early in `main()` and branch into
// `run()` instead of starting the Tauri UI.
//
// Wire protocol (Chromium / Firefox):
//   each message is a 4-byte little-endian length followed by a
//   UTF-8 JSON payload. stdin = extension -> host, stdout = host ->
//   extension, stderr = free for logging.
//
// Responsibilities:
//   - read redd-block-data.json from the app-data dir,
//   - derive the current blocklist (active-blocks ∩ blocklists.websites
//     at time `now()`),
//   - push `{ "blocklist": [...] }` on connect,
//   - re-derive + re-push on file change (via notify) and every 30 s
//     (for time-only schedule transitions),
//   - drop the empty list when nothing is active so the extension
//     clears cleanly.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const POLL_INTERVAL: Duration = Duration::from_secs(30);

enum HostEvent {
    Refresh,
    Recv(String),
    StdinClosed,
    StdinError(String),
}

/// Return true if argv signals that the browser invoked us as a
/// native-messaging host. Native-messaging manifests can't pass custom
/// args, so we sniff for browser-supplied argv markers instead:
///   - explicit `--native-host` flag (smoke-test path)
///   - `chrome-extension://<id>/` (Chromium-family argv[1])
///   - the Firefox extension ID (Firefox argv[1])
///   - `--parent-window=...` (Windows argv suffix from chromium / Firefox)
pub fn is_native_host_invocation() -> bool {
    for arg in std::env::args().skip(1) {
        if arg == "--native-host" {
            return true;
        }
        if arg.starts_with("chrome-extension://") {
            return true;
        }
        if arg == crate::native_host_install::FIREFOX_EXT_ID {
            return true;
        }
        if arg.starts_with("--parent-window=") {
            return true;
        }
    }
    false
}

/// Entry point. Blocks until stdin closes.
pub fn run() -> ! {
    #[cfg(target_os = "windows")]
    crate::windows_process::set_native_host_process_directory();

    log_to_file(&format!(
        "spawned pid={} exe={:?} argv={:?}",
        std::process::id(),
        std::env::current_exe().ok(),
        std::env::args().collect::<Vec<_>>()
    ));

    let data_path = match resolve_data_path() {
        Some(p) => p,
        None => {
            log_to_file("resolve_data_path returned None; exiting");
            std::process::exit(1);
        }
    };

    // Push once on connect.
    let (domains, blocks) = derive_payload(&data_path);
    send_payload(&domains, &blocks);

    // Background refresh: file-watch + 30 s poll. Read stdin on its
    // own thread so native-host updates do not depend on the extension
    // sending heartbeat messages. Native messaging is commonly quiet
    // extension -> host after connect; blocking this thread on stdin
    // would otherwise prevent pause/stop updates from ever being
    // pushed until the browser writes something.
    let (tx, rx) = mpsc::channel::<HostEvent>();
    spawn_file_watcher(&data_path, tx.clone());
    spawn_poller(tx.clone());
    spawn_stdin_reader(tx);

    // On any refresh signal (file-watch or poll tick), re-derive and
    // push. Stdin events only keep lifecycle/logging wired up.
    loop {
        match rx.recv() {
            Ok(HostEvent::Refresh) => {
                log_to_file("refresh signal; deriving payload");
                let (domains, blocks) = derive_payload(&data_path);
                send_payload(&domains, &blocks);
            }
            Ok(HostEvent::Recv(s)) => {
                log_to_file(&format!("recv: {s}"));
            }
            Ok(HostEvent::StdinClosed) => {
                log_to_file("stdin EOF; exiting");
                std::process::exit(0);
            }
            Ok(HostEvent::StdinError(e)) => {
                log_to_file(&format!("stdin read error: {e}; exiting"));
                std::process::exit(1);
            }
            Err(_) => {
                log_to_file("event channel closed; exiting");
                std::process::exit(1);
            }
        }
    }
}

fn spawn_stdin_reader(tx: mpsc::Sender<HostEvent>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut stdin_lock = stdin.lock();
        loop {
            let mut len_buf = [0u8; 4];
            match stdin_lock.read_exact(&mut len_buf) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    let _ = tx.send(HostEvent::StdinClosed);
                    return;
                }
                Err(e) => {
                    let _ = tx.send(HostEvent::StdinError(e.to_string()));
                    return;
                }
            }
            let len = u32::from_le_bytes(len_buf) as usize;
            let mut payload = vec![0u8; len];
            if let Err(e) = stdin_lock.read_exact(&mut payload) {
                let _ = tx.send(HostEvent::StdinError(format!("payload: {e}")));
                return;
            }

            // We accept but don't currently act on extension -> host
            // messages beyond logging. Heartbeats from the extension
            // could live here later.
            if let Ok(s) = std::str::from_utf8(&payload) {
                let _ = tx.send(HostEvent::Recv(s.to_string()));
            }
        }
    });
}

/// Send a payload to the extension over stdout. Emits both the legacy flat
/// `blocklist` (domain strings) and the richer `blocks` array
/// (per-block metadata: name, emoji, color, mode, source, startedAt, endsAt).
/// `blocklist` remains the backward-compatible contract: only blocklist-mode
/// website domains belong there. `blocks` is additive, so allowlist-only
/// website sessions intentionally serialize as an empty flat `blocklist` plus
/// one or more allowlist entries in `blocks`.
fn send_payload(domains: &[String], blocks: &[BlockInfo]) {
    #[derive(Serialize)]
    struct Msg<'a> {
        blocklist: &'a [String],
        blocks: &'a [BlockInfo],
    }
    let msg = Msg {
        blocklist: domains,
        blocks,
    };
    let body = match serde_json::to_vec(&msg) {
        Ok(b) => b,
        Err(e) => {
            log_to_file(&format!("serialize error: {e}"));
            return;
        }
    };
    let len = (body.len() as u32).to_le_bytes();
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if lock
        .write_all(&len)
        .and_then(|_| lock.write_all(&body))
        .is_err()
    {
        // The browser likely closed the pipe; exit cleanly.
        std::process::exit(0);
    }
    let _ = lock.flush();
    log_to_file(&format!(
        "sent blocklist ({} domains, {} blocks)",
        domains.len(),
        blocks.len()
    ));
}

fn spawn_file_watcher(path: &std::path::Path, tx: mpsc::Sender<HostEvent>) {
    let path = path.to_path_buf();
    // We poll mtime rather than depend on the `notify` crate so this
    // module stays dependency-light and works identically on every OS.
    // 2 s cadence is fine — blocklist changes are user-driven and not
    // latency-sensitive at the second level.
    std::thread::spawn(move || {
        let mut last = mtime(&path);
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let current = mtime(&path);
            if current != last {
                last = current;
                let _ = tx.send(HostEvent::Refresh);
            }
        }
    });
}

fn spawn_poller(tx: mpsc::Sender<HostEvent>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let _ = tx.send(HostEvent::Refresh);
    });
}

fn mtime(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Per-block metadata sent alongside the flat `blocklist`. Mirrors the
/// additive `blocks[]` shape the ReDD Focus extension reads and forwards to
/// `blocked.html` for the pill / source / countdown UI. Consumers must treat
/// every field here as optional/backward-compatible and fall back to legacy
/// flat-blocklist behavior when `blocks` or `mode` are absent.
#[derive(Debug, Clone, Serialize)]
pub struct BlockInfo {
    #[serde(rename = "blocklistId")]
    pub blocklist_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// `"blocklist"` (default) or `"allowlist"`. In allowlist mode `domains`
    /// lists sites the user *may* visit; everything else is blocked.
    pub mode: String,
    pub domains: Vec<String>,
    /// Apps from the blocklist for this active segment (blocked or allowed
    /// depending on `mode`). Omitted on the extension wire when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<String>,
    pub source: &'static str, // "schedule" | "activeBlock"
    #[serde(rename = "endsAt", skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
    #[serde(rename = "startedAt", skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

#[cfg(test)]
fn default_blocklist_mode() -> String {
    "blocklist".to_string()
}

pub fn blocklist_mode_is_allowlist(mode: &str) -> bool {
    mode.eq_ignore_ascii_case("allowlist")
}

/// `(name, emoji, color, mode, websites_lowercased, apps)` for one blocklist.
type BlocklistMeta = (
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Vec<String>,
    Vec<String>,
);

/// Read redd-block-data.json and compute (a) the deduped legacy flat
/// blocklist domain list, (b) the additive per-block metadata array sorted
/// ascending by `endsAt`. This is the single source of truth for what the
/// extension sees on every frame.
pub fn derive_payload(data_path: &std::path::Path) -> (Vec<String>, Vec<BlockInfo>) {
    // mtime-keyed parse cache: this runs on every watcher/enforcer tick,
    // but the file only changes on user actions. The derivation below
    // stays live (it depends on now()); only the parse is cached.
    let data = match crate::data_cache::read(data_path) {
        Some(d) => d,
        None => return (vec![], vec![]),
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let blocklists = data
        .get("blocklists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let schedules = data
        .get("schedules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let blocklist_meta = |id: &str| -> Option<BlocklistMeta> {
        blocklists
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
            .map(|b| {
                let name = b.get("name").and_then(|v| v.as_str()).map(String::from);
                let emoji = b.get("emoji").and_then(|v| v.as_str()).map(String::from);
                let color = b.get("color").and_then(|v| v.as_str()).map(String::from);
                let mode = b
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("blocklist")
                    .to_string();
                let websites: Vec<String> = b
                    .get("websites")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_lowercase()))
                            .collect()
                    })
                    .unwrap_or_default();
                let apps: Vec<String> = b
                    .get("apps")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .filter(|n| !crate::app_watcher::is_protected_app_name(n))
                            .collect()
                    })
                    .unwrap_or_default();
                (name, emoji, color, mode, websites, apps)
            })
    };

    let mut domains: std::collections::BTreeSet<String> = Default::default();
    let mut blocks: Vec<BlockInfo> = Vec::new();

    for ab in &active {
        let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        if one_off_pause_active(ab, now_ms) || now_ms < start || now_ms >= end {
            continue;
        }
        let id = match ab.get("blocklistId").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if let Some((name, emoji, color, mode, websites, apps)) = blocklist_meta(id) {
            // Flat `blocklist` is legacy extension blacklist semantics — only
            // blocklist-mode domains belong here. Allowlist enforcement reads
            // `blocks[].mode` + `blocks[].domains` instead.
            if !blocklist_mode_is_allowlist(&mode) {
                for w in &websites {
                    domains.insert(w.clone());
                }
            }
            blocks.push(BlockInfo {
                blocklist_id: id.to_string(),
                name,
                emoji,
                color,
                mode,
                domains: websites,
                apps,
                source: "activeBlock",
                ends_at: Some(end),
                started_at: Some(start),
            });
        }
    }

    for sch in &schedules {
        let m = match match_schedule_now(sch, now_ms) {
            Some(m) => m,
            None => continue,
        };
        let id = match sch.get("blocklistId").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if let Some((name, emoji, color, mode, websites, apps)) = blocklist_meta(id) {
            if !blocklist_mode_is_allowlist(&mode) {
                for w in &websites {
                    domains.insert(w.clone());
                }
            }
            blocks.push(BlockInfo {
                blocklist_id: id.to_string(),
                name,
                emoji,
                color,
                mode,
                domains: websites,
                apps,
                source: "schedule",
                ends_at: m.ends_at,
                started_at: m.started_at,
            });
        }
    }

    blocks.sort_by_key(|b| b.ends_at.unwrap_or(u64::MAX));
    (domains.into_iter().collect(), blocks)
}

/// Backward-compatible wrapper that returns just the flat domain list.
pub fn derive_blocklist(data_path: &std::path::Path) -> Vec<String> {
    derive_payload(data_path).0
}

/// Effective blocked-app set at `now()`, mirroring the frontend's
/// `updateBlockedApps` merge of active one-offs and live schedule
/// segments. App-only schedules (no websites) still contribute here
/// even though `derive_payload` only surfaces domains.
pub fn derive_blocked_apps(data_path: &std::path::Path) -> Vec<String> {
    let data = match crate::data_cache::read(data_path) {
        Some(d) => d,
        None => return vec![],
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let blocklists = data
        .get("blocklists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let schedules = data
        .get("schedules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let blocklist_apps = |id: &str| -> Option<(String, Vec<String>)> {
        blocklists
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
            .map(|b| {
                let mode = b
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("blocklist")
                    .to_string();
                let apps: Vec<String> = b
                    .get("apps")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (mode, apps)
            })
    };

    let mut apps: std::collections::BTreeSet<String> = Default::default();

    for ab in &active {
        let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        if one_off_pause_active(ab, now_ms) || now_ms < start || now_ms >= end {
            continue;
        }
        let Some(id) = ab.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    for sch in &schedules {
        if match_schedule_now(sch, now_ms).is_none() {
            continue;
        }
        let Some(id) = sch.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    apps.into_iter().collect()
}

/// Effective allowed-app set for allowlist-mode blocks at `now()`.
/// Mirrors the frontend's `collectManualAllowedApps` /
/// `collectScheduleAllowedApps` merge.
pub fn derive_allowed_apps(data_path: &std::path::Path) -> Vec<String> {
    let data = match crate::data_cache::read(data_path) {
        Some(d) => d,
        None => return vec![],
    };
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let blocklists = data
        .get("blocklists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let active = data
        .get("activeBlocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let schedules = data
        .get("schedules")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let blocklist_apps = |id: &str| -> Option<(String, Vec<String>)> {
        blocklists
            .iter()
            .find(|b| b.get("id").and_then(|v| v.as_str()) == Some(id))
            .map(|b| {
                let mode = b
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("blocklist")
                    .to_string();
                let apps: Vec<String> = b
                    .get("apps")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (mode, apps)
            })
    };

    let mut apps: std::collections::BTreeSet<String> = Default::default();

    for ab in &active {
        let start = ab.get("startTime").and_then(|v| v.as_u64()).unwrap_or(0);
        let end = ab.get("endTime").and_then(|v| v.as_u64()).unwrap_or(0);
        if one_off_pause_active(ab, now_ms) || now_ms < start || now_ms >= end {
            continue;
        }
        let Some(id) = ab.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if !blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    for sch in &schedules {
        if match_schedule_now(sch, now_ms).is_none() {
            continue;
        }
        let Some(id) = sch.get("blocklistId").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((mode, block_apps)) = blocklist_apps(id) else {
            continue;
        };
        if !blocklist_mode_is_allowlist(&mode) {
            continue;
        }
        for app in block_apps {
            if !crate::app_watcher::is_protected_app_name(&app) {
                apps.insert(app);
            }
        }
    }

    apps.into_iter().collect()
}

#[derive(Debug, Clone, Copy)]
struct ScheduleMatch {
    started_at: Option<u64>,
    ends_at: Option<u64>,
}

/// Whether a one-off block's pause still suppresses enforcement at `now_ms`.
///
/// Mirrors the schedule rule in `match_schedule_now`: a pause holds only until
/// `pauseEndTime`. Derivation must not wait for the frontend to clear
/// `isPaused` — that sweep is a 1 s JS interval in `src/render.js`, and macOS
/// throttles WKWebView timers while the window is hidden, which is the app's
/// normal tray state. Keying off the flag alone left a block silently
/// unenforced past its pause end.
///
/// A missing `pauseEndTime` reads as "not paused", matching the schedule rule.
/// Both pause paths (`confirm-modals.js`, and the Android reconciliation in
/// `blocking-platform.js`) always write the two fields together, so an
/// end-time-less pause is not reachable from the app.
pub(crate) fn one_off_pause_active(active_block: &Value, now_ms: u64) -> bool {
    let paused = active_block
        .get("isPaused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !paused {
        return false;
    }
    let pause_end = active_block
        .get("pauseEndTime")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    pause_end > now_ms
}

/// If any segment of `schedule` is active at `now_ms`, return the
/// absolute start/end epoch-ms of that segment occurrence. Mirrors the
/// frontend `isScheduleSegmentActiveNow` semantics including
/// cross-midnight, all-day, and pause-aware rules.
fn match_schedule_now(schedule: &Value, now_ms: u64) -> Option<ScheduleMatch> {
    let paused = schedule
        .get("isPaused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let pause_end = schedule
        .get("pauseEndTime")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if paused && pause_end > now_ms {
        return None;
    }
    let segments = schedule
        .get("resolvedSegments")
        .and_then(|v| v.as_array())
        .or_else(|| schedule.get("segments").and_then(|v| v.as_array()))?;
    let (wd, hour, minute, sec) = local_time_components_full(now_ms)?;
    let now_min = hour as u32 * 60 + minute as u32;

    // Today's local-midnight as epoch ms. Computed by subtracting the
    // local time-of-day offset from now_ms — works across DST jumps as
    // long as the local-time components themselves are correct.
    let today_offset_secs = (hour as u64) * 3600 + (minute as u64) * 60 + (sec as u64);
    let now_secs = now_ms / 1000;
    let midnight_today_ms = now_secs.saturating_sub(today_offset_secs) * 1000;
    let yesterday_midnight_ms = midnight_today_ms.saturating_sub(86_400_000);

    for seg in segments {
        if let (Some(active_from), Some(active_until)) = (
            seg.get("activeFromTimestampMs").and_then(|v| v.as_u64()),
            seg.get("activeUntilTimestampMs").and_then(|v| v.as_u64()),
        ) {
            if now_ms >= active_from && now_ms < active_until {
                return Some(ScheduleMatch {
                    started_at: Some(active_from),
                    ends_at: Some(active_until),
                });
            }
            continue;
        }

        let sh = seg.get("startHour").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let sm = seg.get("startMinute").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let eh = seg.get("endHour").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let em = seg.get("endMinute").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let start_min = sh * 60 + sm;
        let end_min = eh * 60 + em;
        let days: Vec<u8> = seg
            .get("days")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_u64().map(|x| x as u8))
                    .collect()
            })
            .unwrap_or_default();

        let all_day = start_min == end_min;
        if all_day {
            if days.contains(&wd) {
                return Some(ScheduleMatch {
                    started_at: Some(midnight_today_ms),
                    ends_at: Some(midnight_today_ms + 86_400_000),
                });
            }
            continue;
        }

        if start_min < end_min {
            if days.contains(&wd) && now_min >= start_min && now_min < end_min {
                return Some(ScheduleMatch {
                    started_at: Some(midnight_today_ms + start_min as u64 * 60_000),
                    ends_at: Some(midnight_today_ms + end_min as u64 * 60_000),
                });
            }
        } else {
            // Cross-midnight.
            let yesterday = (wd + 6) % 7;
            if days.contains(&wd) && now_min >= start_min {
                return Some(ScheduleMatch {
                    started_at: Some(midnight_today_ms + start_min as u64 * 60_000),
                    ends_at: Some(midnight_today_ms + 86_400_000 + end_min as u64 * 60_000),
                });
            }
            if days.contains(&yesterday) && now_min < end_min {
                return Some(ScheduleMatch {
                    started_at: Some(yesterday_midnight_ms + start_min as u64 * 60_000),
                    ends_at: Some(midnight_today_ms + end_min as u64 * 60_000),
                });
            }
        }
    }
    None
}

/// Return (weekday 0=Mon..6=Sun, hour 0..23, minute 0..59, second 0..59)
/// in the system local timezone. Uses libc `localtime_r` on unix and
/// `GetLocalTime` on Windows.
///
/// NOTE on weekday encoding: schedule `days` arrays in
/// `redd-block-data.json` are authored by `src/app.js` using the
/// JS Mon=0..Sun=6 convention (see
/// `isScheduleSegmentActiveNow`'s `currentDay` mapping). Both
/// `tm_wday` and Win32 `SYSTEMTIME.wDayOfWeek` are Sun=0..Sat=6, so
/// we shift here once at the source — *not* in `match_schedule_now`
/// — to keep the comparison sites identical to the JS predicate.
fn local_time_components_full(now_ms: u64) -> Option<(u8, u8, u8, u8)> {
    /// C-Sun=0..Sat=6 → JS-Mon=0..Sun=6.
    fn shift_weekday(c_wday: u8) -> u8 {
        if c_wday == 0 {
            6
        } else {
            c_wday - 1
        }
    }

    let secs = (now_ms / 1000) as i64;
    #[cfg(unix)]
    unsafe {
        let time: libc::time_t = secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&time, &mut tm).is_null() {
            return None;
        }
        Some((
            shift_weekday(tm.tm_wday as u8),
            tm.tm_hour as u8,
            tm.tm_min as u8,
            tm.tm_sec as u8,
        ))
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows::Win32::System::Time::FileTimeToSystemTime;
        // Convert unix seconds to a FILETIME (100ns ticks since 1601-01-01).
        const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;
        let ticks = secs * 10_000_000 + EPOCH_DIFF_100NS;
        let ft = FILETIME {
            dwLowDateTime: (ticks as u32),
            dwHighDateTime: ((ticks >> 32) as u32),
        };
        let mut utc = SYSTEMTIME::default();
        let mut local = SYSTEMTIME::default();
        unsafe {
            if FileTimeToSystemTime(&ft, &mut utc).is_err() {
                return None;
            }
            if windows::Win32::System::Time::SystemTimeToTzSpecificLocalTime(None, &utc, &mut local)
                .is_err()
            {
                return None;
            }
        }
        Some((
            shift_weekday(local.wDayOfWeek as u8),
            local.wHour as u8,
            local.wMinute as u8,
            local.wSecond as u8,
        ))
    }
}

/// Canonical app-data path for the running user.
///
/// The native host runs as a child of the user's browser (not as the
/// Tauri app), so it can't ask Tauri for `app_data_dir()`. It does not
/// need to: `canonical_data_path_static` resolves the same per-user path
/// without a handle, and routing through it is what keeps the host and
/// the app on one file. Both run as the same user — the browser that
/// spawned us was launched by them.
///
/// Order:
///   1. The canonical per-user path, if it already exists.
///   2. `<app data>/com.redd.block/...` — an earlier bundle id used by
///      some pre-v1.0 builds; keeps native-messaging working through the
///      migration window.
///   3. The canonical path regardless, so file-watch picks up its first
///      write.
pub fn resolve_data_path() -> Option<PathBuf> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let canonical = crate::commands::canonical_data_path_static();
        if canonical.exists() {
            return Some(canonical);
        }
        if let Some(base) = dirs::data_dir() {
            let legacy = base.join("com.redd.block").join("redd-block-data.json");
            if legacy.exists() {
                return Some(legacy);
            }
        }
        Some(canonical)
    }
}

/// Append a line to a debug log alongside the app-data file. The
/// installed browser also captures stderr into its own log; this file
/// is just so the user (or us) can find out what happened.
fn log_to_file(msg: &str) {
    let Some(mut path) = resolve_data_path() else {
        return;
    };
    path.pop();
    path.push("native-host.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
    // Also emit to stderr; browsers capture it.
    let _ = writeln!(std::io::stderr(), "{msg}");
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DerivedBlocklist {
    pub domains: Vec<String>,
}

#[cfg(test)]
mod tests;
