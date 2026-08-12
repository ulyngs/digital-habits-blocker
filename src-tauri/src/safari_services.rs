//! Rust ↔ Swift bridge into SafariServices, available on macOS only.
//!
//! Two extern "C" entry points implemented in
//! `src-tauri/safari-bridge/safari-bridge.swift`:
//!
//! - [`extension_state`] — calls `SFSafariExtensionManager.getStateOf
//!   SafariExtension(withIdentifier:)` and returns whether the
//!   extension is enabled. Works without Full Disk Access (Apple
//!   designed this API specifically for host apps to introspect
//!   their bundled extension's state).
//!
//! - [`open_extension_settings`] — calls `SFSafariApplication.show
//!   PreferencesForExtension(withIdentifier:)` to deep-link Safari
//!   to the extension's row in Settings → Extensions. Saves the
//!   user ~3 navigation clicks vs opening Safari → Cmd+, →
//!   Extensions tab.
//!
//! The dylib's load commands resolve `@rpath/libsafari_bridge.dylib`
//! against rpaths added to the binary by `build.rs`. See that file
//! for the rpath layout. On non-macOS targets this whole module is
//! gated out so the rest of the crate still builds.

#![cfg(target_os = "macos")]

use std::ffi::{c_char, CString};

extern "C" {
    /// Writes a JSON object describing the extension state into
    /// `out_ptr` (must point to at least `out_len` bytes; the
    /// output is NUL-terminated). Returns 0 on success, non-zero
    /// when SafariServices reported an error (the JSON will then
    /// have an `error` field).
    fn redd_safari_extension_state(
        bundle_id: *const c_char,
        out_ptr: *mut u8,
        out_len: usize,
    ) -> i32;

    /// Tells Safari to show its preferences pane focused on the
    /// extension with the given identifier. Returns 0 on success,
    /// 1 on error.
    fn redd_safari_open_extension_settings(bundle_id: *const c_char) -> i32;
}

/// What we know about a Safari Web Extension's state, as reported
/// by `SFSafariExtensionManager`. SafariServices exposes only
/// `isEnabled` here — private-browsing access and per-site
/// permissions can't be queried from the host app at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionState {
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub enum BridgeError {
    /// SafariServices returned an error (most commonly
    /// `extensionNotFound` if the extension isn't registered with
    /// the system, or the host app isn't recognized as its host).
    SafariServices(String),
    /// The bridge produced output we couldn't parse — should never
    /// happen unless the Swift side and Rust side are mismatched.
    InvalidJson(String),
    /// The bundle identifier had a NUL byte in it, can't be passed
    /// across the C ABI.
    InvalidBundleId,
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::SafariServices(msg) => write!(f, "SafariServices error: {msg}"),
            BridgeError::InvalidJson(msg) => write!(f, "bridge returned invalid JSON: {msg}"),
            BridgeError::InvalidBundleId => write!(f, "bundle identifier contained a NUL byte"),
        }
    }
}

impl std::error::Error for BridgeError {}

/// Query the current state of the Safari Web Extension with the
/// given bundle identifier. Returns `Err` when SafariServices
/// reports an error — the most common case being that the host
/// app the call originates from isn't registered as the host of
/// `bundle_id` (which happens during `cargo run` outside an .app
/// bundle, and during `cargo test`).
pub fn extension_state(bundle_id: &str) -> Result<ExtensionState, BridgeError> {
    let cstr = CString::new(bundle_id).map_err(|_| BridgeError::InvalidBundleId)?;

    // 512 bytes is plenty for the JSON shapes the Swift side emits
    // (`{"enabled": true}` or `{"error": "..."}`). Localized error
    // messages aren't going to overflow this — they're typically
    // <100 bytes — and we NUL-terminate so the C-string read is safe
    // even if Swift truncated the output.
    let mut buf = [0u8; 512];
    let rc = unsafe { redd_safari_extension_state(cstr.as_ptr(), buf.as_mut_ptr(), buf.len()) };

    let nul = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    let json_bytes = &buf[..nul];
    let parsed: serde_json::Value = serde_json::from_slice(json_bytes).map_err(|e| {
        BridgeError::InvalidJson(format!("{e}: {:?}", String::from_utf8_lossy(json_bytes)))
    })?;

    if rc != 0 {
        let msg = parsed
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        return Err(BridgeError::SafariServices(msg));
    }

    let enabled = parsed
        .get("enabled")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| {
            BridgeError::InvalidJson(format!(
                "missing `enabled` field: {}",
                String::from_utf8_lossy(json_bytes)
            ))
        })?;
    Ok(ExtensionState { enabled })
}

/// Tell Safari to show its preferences focused on the extension with
/// the given identifier. Best-effort — returns `Err` if SafariServices
/// can't open the pane (e.g. Safari isn't installed, which doesn't
/// happen on macOS in practice).
pub fn open_extension_settings(bundle_id: &str) -> Result<(), BridgeError> {
    let cstr = CString::new(bundle_id).map_err(|_| BridgeError::InvalidBundleId)?;
    let rc = unsafe { redd_safari_open_extension_settings(cstr.as_ptr()) };
    if rc == 0 {
        Ok(())
    } else {
        Err(BridgeError::SafariServices(
            "showPreferencesForExtension reported an error".to_string(),
        ))
    }
}

#[allow(dead_code)] // silence "unused" if no callers wire it up yet
fn _ensure_cstr_lifetime() {
    // Documents intent: we only borrow CString::as_ptr() for the
    // duration of the FFI call, so the CString staying alive on the
    // stack is sufficient. This empty function exists purely so a
    // future refactor doesn't accidentally pass &CStr::as_ptr()
    // across an await boundary.
    let _ = c"x";
}
