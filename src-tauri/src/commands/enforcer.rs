//! Extension-enforcement shim.
//!
//! Website-blocking enforcement (heartbeat checking, grace-period
//! countdown, browser force-quit, GUI alerts) now lives in the
//! `redd-block-helper` daemon so it keeps running even when the main
//! ReDD Block app is quit. This module is a *thin* Tauri-side shim:
//!
//! 1. On `start_extension_enforcement`, spin up a background thread
//!    that polls the helper every `POLL_INTERVAL` over the existing
//!    helper IPC socket.
//! 2. For every event the helper returns, re-emit it to the frontend as
//!    the existing `extension-enforcement` Tauri event — so the in-app
//!    banner in `src/app.js` keeps working unchanged.
//! 3. Stop the thread on `stop_extension_enforcement`.
//!
//! The frontend is still the source-of-truth for the *in-app banner*;
//! the helper handles the *system-wide alerts + force-quit*. The two
//! halves stay in sync because they both observe the same helper
//! snapshot, with the Tauri app acting as a live relay into the
//! currently-open window.

use std::io::{BufRead, BufReader, Write};
#[cfg(target_os = "windows")]
use std::net::{SocketAddr, TcpStream};
#[cfg(not(target_os = "windows"))]
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[cfg(not(target_os = "windows"))]
const HELPER_SOCKET_PATH: &str = "/tmp/redd-block-helper.sock";
#[cfg(target_os = "windows")]
const HELPER_TCP_ADDR: &str = "127.0.0.1:62222";

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_secs(3);

lazy_static! {
    /// Single-instance guard so `start_extension_enforcement` is idempotent.
    static ref RUNNING: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
}

/// Event payload re-emitted to the frontend as `extension-enforcement`.
/// Matches the shape produced by the helper so we can pass it through
/// without re-mapping field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnforcementEvent {
    pub browser: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
}

/// Start polling the helper and re-emitting events. Returns `true` if
/// the poller actually started this call, `false` if it was already
/// running.
#[tauri::command]
pub async fn start_extension_enforcement(app: AppHandle) -> bool {
    if RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::info!("[enforcer-poll] already running");
        return false;
    }
    log::info!("[enforcer-poll] starting poll loop (interval = {:?})", POLL_INTERVAL);
    let running = Arc::clone(&RUNNING);
    thread::spawn(move || poll_loop(app, running));
    true
}

#[tauri::command]
pub async fn stop_extension_enforcement() -> bool {
    RUNNING.store(false, Ordering::SeqCst);
    log::info!("[enforcer-poll] stop requested");
    true
}

#[tauri::command]
pub async fn is_extension_enforcement_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

// ---------- Poll loop -----------------------------------------------------

fn poll_loop(app: AppHandle, running: Arc<AtomicBool>) {
    let mut since_cursor: u64 = 0;
    while running.load(Ordering::SeqCst) {
        match get_enforcement_state(since_cursor) {
            Ok(reply) => {
                since_cursor = reply.next_cursor.unwrap_or(since_cursor);
                if let Some(events) = reply.events {
                    for event in events {
                        if let Err(e) = app.emit("extension-enforcement", &event) {
                            log::warn!("[enforcer-poll] emit failed: {e}");
                        }
                    }
                }
            }
            Err(e) => {
                // Don't spam the log — helper might just not be running
                // (dev mode without the LaunchDaemon installed). Log
                // every poll at debug; promote to info on intermittent
                // connect errors.
                log::debug!("[enforcer-poll] helper unavailable: {e}");
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    log::info!("[enforcer-poll] loop exited");
}

// ---------- IPC -----------------------------------------------------------

#[derive(Serialize)]
struct HelperRequest<'a> {
    action: &'a str,
    #[serde(rename = "since_cursor")]
    since_cursor: u64,
}

#[derive(Deserialize, Default)]
struct HelperReply {
    #[serde(default)]
    #[allow(dead_code)]
    success: bool,
    #[serde(default)]
    events: Option<Vec<EnforcementEvent>>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<u64>,
    #[serde(default)]
    #[allow(dead_code)]
    enforcement: Option<serde_json::Value>,
    #[serde(default)]
    #[allow(dead_code)]
    error: Option<String>,
}

fn get_enforcement_state(since_cursor: u64) -> Result<HelperReply, String> {
    let req = HelperRequest {
        action: "get-enforcement-state",
        since_cursor,
    };
    let json = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    let line = send_line(&json)?;
    serde_json::from_str::<HelperReply>(&line).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn send_line(line: &str) -> Result<String, String> {
    let mut stream = UnixStream::connect(HELPER_SOCKET_PATH)
        .map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    writeln!(stream, "{line}").map_err(|e| format!("write: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|e| format!("read: {e}"))?;
    Ok(response)
}

#[cfg(target_os = "windows")]
fn send_line(line: &str) -> Result<String, String> {
    let addr: SocketAddr = HELPER_TCP_ADDR
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, IO_TIMEOUT)
        .map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    writeln!(stream, "{line}").map_err(|e| format!("write: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|e| format!("read: {e}"))?;
    Ok(response)
}
