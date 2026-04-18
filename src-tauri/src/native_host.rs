//! Native messaging host loop.
//!
//! When the Tauri binary is launched with `--native-host` (typically by a
//! browser via the extension-installed native messaging manifest), we branch
//! into this module instead of booting Tauri. The protocol is Chrome-style
//! native messaging:
//!
//!   [u32 little-endian length][UTF-8 JSON payload]
//!
//! on both stdin (extension → host) and stdout (host → extension). `stderr`
//! is free for logging. The browser writes our stderr into its own logs.
//!
//! Contract with the extension side (see `reddfocus-open-source` patch):
//!   Host → extension: {
//!     "blocklist": [<domain>, ...],           // flat, for fast hostname match
//!     "blocks":    [ActiveBlockInfo, ...]     // per-blocklist metadata for
//!                                              // the blocked-page card
//!   }
//!   Extension → host: treated as a heartbeat; echoed for debugging.
//!   Older extension builds that ignore `blocks` keep working.
//!
//! Publish triggers:
//!   - on connect (immediately),
//!   - when the data file changes (`notify` watcher on candidate paths),
//!   - every 30 seconds as a safety net for time-only transitions
//!     (scheduled window that starts/ends at 5 pm does not touch the data
//!     file, so the watcher never fires).

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use notify::{EventKind, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::json;

use crate::blocklist;
use crate::commands::extension::heartbeat_file;

/// Poll cadence. Matches the MVP README's "30 s poll" so scheduled windows
/// that end purely by time still fire within a bounded delay.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Debounce window after a file event. Tauri save happens as a handful of
/// fsync/rename bursts; bundling them keeps us from spamming the extension
/// with 3–4 identical messages back-to-back.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);

/// How often the heartbeat thread refreshes its per-browser stamp file.
/// Shorter than the enforcer's `HEARTBEAT_STALE_AFTER` (4 s) so a single
/// missed write doesn't spuriously fail the check.
const HEARTBEAT_CADENCE: Duration = Duration::from_secs(1);

/// Log file shared with the MVP Node host for consistency; the daemon writes
/// occasional lines there for post-hoc debugging. Never panics on failure —
/// the browser captures our stderr anyway.
fn log_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".into());
        PathBuf::from(&program_data).join("ReDD Block").join("native-host.log")
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            home.join("Library")
                .join("Application Support")
                .join("ReDD Block")
                .join("native-host.log")
        } else {
            PathBuf::from("/tmp/redd-block-native-host.log")
        }
    }
}

fn log(msg: &str) {
    // Always mirror to stderr so the browser dev tools can see it.
    let _ = writeln!(std::io::stderr(), "[redd-block native-host] {}", msg);
    // Best-effort append to a stable log location for post-mortem debugging.
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

/// Serialize `msg` as JSON and emit one Chrome-native-messaging frame to
/// stdout. We take a lock before writing so the watcher/poll threads can't
/// interleave partial frames.
fn send_frame<T: Serialize>(stdout_lock: &Mutex<()>, msg: &T) -> std::io::Result<()> {
    let _g = stdout_lock.lock().unwrap();
    let payload = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    let len = payload.len();
    if len > 1024 * 1024 {
        // Chrome hard-caps at 1 MiB. Truncation is meaningless for a blocklist
        // payload; log and drop instead.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "native messaging frame exceeds 1 MiB",
        ));
    }
    let mut out = std::io::stdout();
    let len_bytes = (len as u32).to_le_bytes();
    out.write_all(&len_bytes)?;
    out.write_all(&payload)?;
    out.flush()?;
    Ok(())
}

/// Read loop for incoming messages. We don't currently need to handle
/// anything the extension sends, but draining stdin keeps the pipe healthy
/// and gives us a liveness signal: when stdin closes, the browser has
/// disconnected and we should exit cleanly.
fn spawn_stdin_reader(tx: Sender<StdinEvent>) {
    thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stdin.read(&mut chunk) {
                Ok(0) => {
                    let _ = tx.send(StdinEvent::Closed);
                    break;
                }
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    // Drain whole frames.
                    while buffer.len() >= 4 {
                        let len_bytes: [u8; 4] = buffer[..4].try_into().unwrap();
                        let len = u32::from_le_bytes(len_bytes) as usize;
                        if buffer.len() < 4 + len {
                            break;
                        }
                        let payload = buffer[4..4 + len].to_vec();
                        buffer.drain(..4 + len);
                        let _ = tx.send(StdinEvent::Frame(payload));
                    }
                }
                Err(e) => {
                    let _ = tx.send(StdinEvent::Error(e.to_string()));
                    break;
                }
            }
        }
    });
}

enum StdinEvent {
    Frame(Vec<u8>),
    Closed,
    Error(String),
}

enum Trigger {
    FileChange,
    Poll,
    Stdin(StdinEvent),
}

/// Parse `--browser-label=<Label>` from argv. Returns `None` when the host
/// was invoked without the flag (older installs, manual invocation).
fn browser_label_from_argv() -> Option<String> {
    const KEY: &str = "--browser-label=";
    for arg in std::env::args() {
        if let Some(rest) = arg.strip_prefix(KEY) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Spawn a background thread that periodically refreshes the heartbeat
/// stamp for `label`. The file's contents are just a unix-millis timestamp
/// (humans and the enforcer both read it, though the enforcer mostly looks
/// at mtime). Returns an `Arc<AtomicBool>` the caller can flip to stop the
/// thread; not strictly necessary today since the thread dies with the
/// process, but cleaner if we ever return non-fatally from `run()`.
fn spawn_heartbeat(label: String) -> Arc<AtomicBool> {
    let running = Arc::new(AtomicBool::new(true));
    let running_for_thread = running.clone();
    thread::spawn(move || {
        let path = match heartbeat_file(&label) {
            Some(p) => p,
            None => {
                log(&format!(
                    "heartbeat: no artifacts dir; disabling for label={label}"
                ));
                return;
            }
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log(&format!("heartbeat: create_dir_all {:?}: {e}", parent));
            }
        }
        // Tight initial write so the enforcer sees fresh state within one
        // tick of spawn, even if the first full cadence hasn't elapsed.
        write_heartbeat(&path);
        while running_for_thread.load(Ordering::SeqCst) {
            thread::sleep(HEARTBEAT_CADENCE);
            if !running_for_thread.load(Ordering::SeqCst) {
                break;
            }
            write_heartbeat(&path);
        }
    });
    running
}

fn write_heartbeat(path: &std::path::Path) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // `std::fs::write` truncates and rewrites, which is atomic *enough* for
    // our purposes (the enforcer only cares about freshness of the file's
    // mtime, not the payload). If the write fails we log and move on — a
    // transient EIO shouldn't kill the native host.
    if let Err(e) = std::fs::write(path, format!("{now_ms}\npid={}\n", std::process::id())) {
        log(&format!("heartbeat: write {:?}: {e}", path));
    }
}

/// Entry point for the native-host subcommand. Loops until stdin closes
/// or a fatal error occurs; never returns `Ok(())` normally because Chrome
/// relies on the exit code as a signal ("the host crashed").
pub fn run() -> std::io::Result<()> {
    log(&format!("spawned pid={} argv={:?}", std::process::id(), std::env::args().collect::<Vec<_>>()));

    // Start the per-browser heartbeat as early as possible. If the shim
    // didn't pass a label (pre-heartbeat install or manual invocation) we
    // fall back to the string "unknown" so the file still exists and can
    // be observed — the enforcer just won't trust it for freshness.
    let label = browser_label_from_argv().unwrap_or_else(|| "unknown".to_string());
    log(&format!("heartbeat: using label={label}"));
    let heartbeat_running = spawn_heartbeat(label);

    let stdout_lock = Mutex::new(());

    // Send the initial snapshot immediately so the extension never sits in
    // "empty while native-host is up" state. One trip through the data file
    // gives us both the flat domain list and the rich per-blocklist blocks.
    let (initial_domains, initial_blocks) = snapshot();
    log(&format!(
        "initial snapshot: {} domain(s) / {} block(s)",
        initial_domains.len(),
        initial_blocks.len()
    ));
    if let Err(e) = send_frame(
        &stdout_lock,
        &json!({ "blocklist": initial_domains, "blocks": initial_blocks }),
    ) {
        log(&format!("failed to send initial frame: {e}"));
        return Err(e);
    }

    // Track what we last sent so we can skip redundant writes. We compare
    // domains + blocks together because `endsAt` inside a block can change
    // as wall-clock time advances (countdown precision) without changing
    // the flat domain list.
    let mut last_domains: Vec<String> = initial_domains;
    let mut last_blocks_json: String = serde_json::to_string(&initial_blocks).unwrap_or_default();

    // Wire up the file watcher. `notify` returns Event structs; we care about
    // any write/rename/create in the parent dir that matches our filename.
    let (watcher_tx, watcher_rx) = channel::<notify::Event>();
    let mut watcher = {
        let tx = watcher_tx.clone();
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
    }
    .map_err(|e| std::io::Error::other(format!("watcher init: {e}")))?;

    for parent in blocklist::watch_parents() {
        match watcher.watch(&parent, RecursiveMode::NonRecursive) {
            Ok(()) => log(&format!("watching {:?}", parent)),
            Err(e) => log(&format!("failed to watch {:?}: {}", parent, e)),
        }
    }

    // Stdin reader thread feeds a channel so we can multiplex stdin + file +
    // timer in the main loop with non-blocking try_recv.
    let (stdin_tx, stdin_rx) = channel::<StdinEvent>();
    spawn_stdin_reader(stdin_tx);

    // Main event loop. Each iteration wakes up on one of three sources, then
    // after a short debounce resolves the current blocklist and pushes.
    let mut next_poll = Instant::now() + POLL_INTERVAL;
    let mut pending_file_change_at: Option<Instant> = None;

    loop {
        let trigger = wait_for_trigger(
            &stdin_rx,
            &watcher_rx,
            &mut next_poll,
            &mut pending_file_change_at,
        );

        match trigger {
            Trigger::Stdin(StdinEvent::Closed) => {
                log("stdin closed; exiting cleanly");
                heartbeat_running.store(false, Ordering::SeqCst);
                return Ok(());
            }
            Trigger::Stdin(StdinEvent::Error(e)) => {
                log(&format!("stdin error: {e}"));
                heartbeat_running.store(false, Ordering::SeqCst);
                return Ok(());
            }
            Trigger::Stdin(StdinEvent::Frame(payload)) => {
                // Extension pings are echoed for debugging and ignored otherwise.
                let preview = String::from_utf8_lossy(&payload).to_string();
                log(&format!("recv from extension: {preview}"));
                continue;
            }
            Trigger::FileChange | Trigger::Poll => {
                // Recompute both domains + rich blocks in a single pass; only
                // send if either changed. Comparing the blocks as their JSON
                // text is cheap and avoids a bespoke PartialEq impl.
                let (domains, blocks) = snapshot();
                let blocks_json = serde_json::to_string(&blocks).unwrap_or_default();
                if domains != last_domains || blocks_json != last_blocks_json {
                    log(&format!(
                        "snapshot changed → {} domain(s) / {} block(s)",
                        domains.len(),
                        blocks.len()
                    ));
                    if let Err(e) = send_frame(
                        &stdout_lock,
                        &json!({ "blocklist": domains, "blocks": blocks }),
                    ) {
                        log(&format!("send failed: {e}"));
                        return Err(e);
                    }
                    last_domains = domains;
                    last_blocks_json = blocks_json;
                }
            }
        }
    }
}

/// Block until something interesting happens. Returns the first trigger that
/// fires; silently swallows non-relevant file events.
fn wait_for_trigger(
    stdin_rx: &Receiver<StdinEvent>,
    watcher_rx: &Receiver<notify::Event>,
    next_poll: &mut Instant,
    pending_file_change_at: &mut Option<Instant>,
) -> Trigger {
    loop {
        // 1) Flush any already-queued stdin events first (closed / frame).
        match stdin_rx.try_recv() {
            Ok(evt) => return Trigger::Stdin(evt),
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => return Trigger::Stdin(StdinEvent::Closed),
        }

        // 2) If a file change has debounced long enough, fire it now.
        if let Some(at) = *pending_file_change_at {
            if Instant::now() >= at + WATCH_DEBOUNCE {
                *pending_file_change_at = None;
                return Trigger::FileChange;
            }
        }

        // 3) If the poll deadline has elapsed, fire a poll.
        if Instant::now() >= *next_poll {
            *next_poll = Instant::now() + POLL_INTERVAL;
            return Trigger::Poll;
        }

        // 4) Drain watcher events. We only care about events that may affect
        //    a candidate data file; anything else is noise.
        match watcher_rx.try_recv() {
            Ok(ev) => {
                if event_matches_data_file(&ev) {
                    // Start / extend debounce window.
                    *pending_file_change_at = Some(Instant::now());
                }
                continue;
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) => {
                // Watcher died; fall back to poll-only behavior.
            }
        }

        // 5) Nothing ready; sleep briefly. A small fixed tick keeps the loop
        //    cheap without starving any source for too long.
        let now = Instant::now();
        let next_wake = [
            pending_file_change_at.map(|at| at + WATCH_DEBOUNCE),
            Some(*next_poll),
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(now + Duration::from_millis(100));
        let sleep = next_wake.saturating_duration_since(now).min(Duration::from_millis(250));
        thread::sleep(sleep);
    }
}

/// Read the data file once and derive both the flat domain list (fast-
/// path blocklist check in the extension) and the enriched per-blocklist
/// blocks (metadata for the blocked-page card). Two separate derivation
/// passes would parse the JSON twice; this keeps it to a single read.
fn snapshot() -> (Vec<String>, Vec<blocklist::ActiveBlockInfo>) {
    match blocklist::read_app_data() {
        Some((_, data)) => (
            blocklist::derive_active_domains(&data),
            blocklist::derive_active_blocks(&data),
        ),
        None => (Vec::new(), Vec::new()),
    }
}

fn event_matches_data_file(event: &notify::Event) -> bool {
    let target = blocklist::data_file_name();
    match event.kind {
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => event
            .paths
            .iter()
            .any(|p| p.file_name().and_then(|n| n.to_str()) == Some(target)),
        _ => false,
    }
}
