//! Per-browser native-host heartbeat stamp files.
//!
//! The native-host subprocess (spawned by the browser extension) writes a
//! tiny `.stamp` file under `<artifacts>/native-host-heartbeats/<Label>.stamp`
//! every ~1 s while it's connected. The enforcement loop inspects the
//! mtime of those stamps to learn, within ~1 s, whether the extension is
//! still talking to us — much faster than Chrome's on-disk Preferences
//! commit (which can lag by up to ~10 s).
//!
//! This module exposes the stamp-path helpers and a freshness probe that
//! both the Tauri app (for its diagnostics pane) and the helper daemon
//! (for the actual enforcement loop) rely on.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub use crate::paths::{heartbeat_dir, heartbeat_file};

/// Maximum allowed age of a heartbeat stamp before we treat the native
/// host as "not responding". The native host refreshes the stamp every
/// ~1 s, so 4 s gives us three missed writes of headroom for disk spikes
/// and scheduler jitter.
pub const HEARTBEAT_STALE_AFTER: Duration = Duration::from_secs(4);

/// Snapshot of a browser's heartbeat stamp.
#[derive(Debug, Clone, Copy)]
pub enum HeartbeatStatus {
    /// File exists and was updated within [`HEARTBEAT_STALE_AFTER`].
    Fresh(Duration),
    /// File exists but hasn't been updated within the stale window. The
    /// native host almost certainly died — user disabled the extension,
    /// extension crashed, or the browser killed the port.
    Stale(Duration),
    /// No stamp file on disk. Typical for a fresh install / first run
    /// before the browser has ever spawned our host. Treated as "no
    /// signal" — callers defer to the slower Preferences probe.
    Missing,
}

/// Read the stamp file at `<home>/…/<Label>.stamp` and classify it. Uses
/// `modified()` (a single stat call) rather than reading the file body —
/// `std::fs::write` updates mtime, so the mtime is the authoritative
/// "last heartbeat" time.
pub fn heartbeat_status(home: &Path, label: &str) -> HeartbeatStatus {
    let path = match heartbeat_file(home, label) {
        Some(p) => p,
        None => return HeartbeatStatus::Missing,
    };
    classify_stamp_path(&path)
}

fn classify_stamp_path(path: &PathBuf) -> HeartbeatStatus {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return HeartbeatStatus::Missing,
    };
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
