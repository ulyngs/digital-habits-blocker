//! Shared primitives used by both the Tauri app (`redd_block_lib`) and the
//! privileged helper daemon (`redd-block-helper`).
//!
//! Everything in here is intentionally *free of Tauri* — we need to call it
//! from the helper, which is a plain Rust binary with no UI stack. The
//! top-level modules are:
//!
//! - [`blocklist`] — derive the currently-active list of blocked domains
//!   from the shared `redd-block-data.json` file.
//! - [`browser`] — browser identity metadata, native-messaging probing
//!   (Chromium + Firefox), and failure categorisation used by the
//!   enforcement loop.
//! - [`heartbeat`] — per-browser heartbeat stamp path + freshness probe
//!   written by the native-host subprocess.
//! - [`user`] — on macOS, resolve the logged-in console user so the root
//!   helper can read *their* browser prefs / heartbeats, and dispatch UI
//!   into their Aqua session via `launchctl asuser`.
//! - [`paths`] — shared filesystem-path helpers (artifacts dir, etc.)
//!   parameterised on the user's home directory.
//!
//! Everything that needs a path under the user's home directory takes an
//! explicit `user_home: &Path` argument. The Tauri app passes
//! `dirs::home_dir()` (it always runs as the logged-in user). The helper
//! daemon passes [`user::effective_user_home`] which on macOS resolves the
//! *console user's* home (because the helper itself runs as `root`).

pub mod blocklist;
pub mod browser;
pub mod enforcement;
pub mod heartbeat;
pub mod paths;
pub mod user;

pub use blocklist::{
    candidate_data_paths, current_active_blocks, current_blocklist,
    current_blocklist_with_source, data_file_name, derive_active_blocks,
    derive_active_domains, read_app_data, resolve_data_path, watch_parents,
    ActiveBlockInfo, DerivedActiveBlock, DerivedAppData, DerivedBlocklist, DerivedSchedule,
    DerivedSegment, PROTECTED_DOMAINS,
};
pub use browser::{
    browser_table, is_manifest_installed, probe_chromium, probe_firefox, BrowserMeta,
    BrowserStatus, ExtensionStatusReport, ProfileStatus, NATIVE_HOST_NAME, SHIM_BROWSERS,
};
pub use enforcement::{
    action_button_label, failure_kind_for, failure_message_body, EnforcementEvent,
    EnforcementSnapshot, FailureKind, PerBrowserState,
};
pub use heartbeat::{heartbeat_dir, heartbeat_file, heartbeat_status, HeartbeatStatus};
