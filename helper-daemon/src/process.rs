//! Cross-platform process helpers used by the enforcement loop.
//!
//! Keeps all of the "is this browser running?" / "please quit this
//! browser" logic in one place so the enforcer module stays focused on
//! state-machine concerns.

use std::process::{Command, Stdio};
use std::time::Duration;

use redd_block_core::browser::BrowserMeta;

/// Cross-platform "is at least one process with any of these names
/// running right now?" probe. On macOS / Linux we shell out to `pgrep`;
/// on Windows we use `tasklist /FI IMAGENAME=…`.
pub fn is_browser_running(meta: &BrowserMeta) -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        for name in meta.proc_names {
            // -x: exact-match the process name to avoid matching
            // "Google Chrome Helper" when we're asking about
            // "Google Chrome".
            let out = Command::new("pgrep")
                .arg("-x")
                .arg(name)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if let Ok(status) = out {
                if status.success() {
                    return true;
                }
            }
        }
        false
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        for name in meta.proc_names {
            let out = Command::new("tasklist")
                .args(["/NH", "/FI", &format!("IMAGENAME eq {}", name)])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            if let Ok(output) = out {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // `tasklist` prints "INFO: No tasks…" if nothing
                // matches, so look for the exe name in the output.
                if stdout.to_lowercase().contains(&name.to_lowercase()) {
                    return true;
                }
            }
        }
        false
    }
}

/// Force-quit all processes for a browser. Returns `true` if the
/// command appeared to succeed — we don't hard-verify the process is
/// gone, because browsers take a moment to actually exit. The enforcer
/// will re-probe on the next tick and find `is_browser_running = false`
/// anyway.
pub fn quit_browser(meta: &BrowserMeta) -> bool {
    log_helper(&format!(
        "[enforcer] quitting {} ({} processes)",
        meta.app_name,
        meta.proc_names.join(", ")
    ));

    #[cfg(target_os = "macos")]
    {
        // Prefer a graceful AppleScript quit delivered into the console
        // user's Aqua session. Fall back to `pkill` if that can't be
        // dispatched (no console user, osascript missing, etc).
        let script = format!(
            r#"tell application "{}" to quit"#,
            sanitize_app_name(meta.app_name)
        );
        let asuser_ok = crate::alert::run_osascript_asuser(&script).unwrap_or(false);
        if asuser_ok {
            // Give the browser a beat to actually exit — on the next
            // tick we re-probe and will refuse to fire further nags if
            // the process is gone.
            std::thread::sleep(Duration::from_millis(300));
            return true;
        }
        log_helper(&format!(
            "[enforcer] graceful quit of {} failed, falling back to pkill",
            meta.app_name
        ));
        let mut any_ok = false;
        for name in meta.proc_names {
            let status = Command::new("pkill")
                .arg("-x")
                .arg(name)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if matches!(status, Ok(s) if s.success()) {
                any_ok = true;
            }
        }
        any_ok
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut any_ok = false;
        for name in meta.proc_names {
            let status = Command::new("taskkill")
                .args(["/F", "/IM", name])
                .creation_flags(CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if matches!(status, Ok(s) if s.success()) {
                any_ok = true;
            }
        }
        any_ok
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut any_ok = false;
        for name in meta.proc_names {
            let status = Command::new("pkill")
                .arg("-x")
                .arg(name)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if matches!(status, Ok(s) if s.success()) {
                any_ok = true;
            }
        }
        any_ok
    }
}

/// Strip everything that isn't safe inside an AppleScript string literal
/// so `tell application "…"` can't be escaped by a maliciously-crafted
/// browser name (unlikely, but free defense-in-depth).
#[cfg(target_os = "macos")]
fn sanitize_app_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_' || *c == '.')
        .collect()
}

fn log_helper(msg: &str) {
    // Matches the parent module's `log()` formatting (seconds since
    // epoch prefix). We don't call super::log() because enforcer is a
    // sibling module — piping through the same stdout is sufficient.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("[{}] {}", now, msg);
}
