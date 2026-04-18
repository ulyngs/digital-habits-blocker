//! GUI alert dispatch for the helper daemon.
//!
//! The helper runs as `root` on macOS via LaunchDaemon, so a plain
//! `osascript display dialog ...` wouldn't render into anybody's Aqua
//! session — it would succeed silently into a root context no user can
//! see. Every dialog therefore has to be forwarded into the console
//! user's session via `launchctl asuser <uid>`.
//!
//! On Windows the helper runs as the logged-in user (scheduled task
//! with `/RL HIGHEST`), so a plain PowerShell MessageBox works fine.

use std::io::Write;
use std::process::{Command, Stdio};
use std::thread;

use redd_block_core::browser::BrowserMeta;
use redd_block_core::enforcement::FailureKind;
use redd_block_core::user::console_user;

/// Fire a user-facing failure alert with two buttons: "Dismiss" and a
/// contextual action button (e.g. "Open ReDD Focus settings in
/// Chrome"). If the user clicks the action button, we attempt to open
/// the browser's extensions page straight into the running Aqua
/// session; otherwise the dialog just goes away and the enforcer keeps
/// counting down to the force-quit.
///
/// This is spawned on its own thread so the blocking `osascript` /
/// PowerShell call doesn't stall the enforcement tick.
pub fn failure_alert(
    meta: &BrowserMeta,
    _kind: FailureKind,
    title: &str,
    body: &str,
    action_button: &str,
) {
    let meta = meta.clone();
    let title = title.to_string();
    let body = body.to_string();
    let action_button = action_button.to_string();
    thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            fire_macos_dialog(&meta, &title, &body, &action_button);
        }
        #[cfg(target_os = "windows")]
        {
            fire_windows_dialog(&meta, &title, &body, &action_button);
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (&meta, &title, &body, &action_button);
        }
    });
}

/// Short follow-up notification after we've already force-closed a
/// browser. No action button — the user needs to turn the extension
/// back on and reopen the browser themselves.
pub fn quit_notification(meta: &BrowserMeta, quit_ok: bool, reason: &str) {
    let title = if quit_ok {
        format!("ReDD Block closed {}", meta.app_name)
    } else {
        format!("ReDD Block tried to close {}", meta.app_name)
    };
    let body = if quit_ok {
        format!(
            "Your block was leaking because ReDD Focus was turned off ({}). \
             Turn it back on and re-open {} to resume.",
            reason, meta.app_name,
        )
    } else {
        format!(
            "Couldn't close {} automatically. Please close it yourself \
             or turn ReDD Focus back on.",
            meta.app_name
        )
    };

    let meta = meta.clone();
    thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            fire_macos_notification(&meta, &title, &body);
        }
        #[cfg(target_os = "windows")]
        {
            fire_windows_notification(&title, &body);
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (&meta, &title, &body);
        }
    });
}

// ---------- macOS ---------------------------------------------------------

/// Run an arbitrary AppleScript string in the console user's Aqua
/// session via `launchctl asuser <uid> /usr/bin/osascript -e <script>`.
/// Returns `Some(stdout)` on success, `None` if the user can't be
/// resolved or the script failed.
#[cfg(target_os = "macos")]
pub fn run_osascript_asuser(script: &str) -> Option<bool> {
    let user = console_user()?;
    let uid = user.uid?;
    let output = Command::new("launchctl")
        .arg("asuser")
        .arg(uid.to_string())
        .arg("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    Some(output.status.success())
}

#[cfg(not(target_os = "macos"))]
pub fn run_osascript_asuser(_script: &str) -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
fn fire_macos_dialog(meta: &BrowserMeta, title: &str, body: &str, action_button: &str) {
    // Resolve the app icon from the installed bundle or the dev path
    // so the dialog is clearly branded as ReDD Block (and not just an
    // unbranded AppleScript dialog).
    let icon_clause = macos_icon_clause();

    // Use `display dialog` (not `display alert`) because it supports a
    // custom icon and arbitrary button labels.
    let title_safe = applescript_escape(title);
    let body_safe = applescript_escape(body);
    let action_safe = applescript_escape(action_button);

    let script = format!(
        r#"try
            set dlg to display dialog "{body}" with title "{title}" buttons {{"Dismiss", "{action}"}} default button "{action}"{icon} giving up after 25
            set btn to button returned of dlg
            if btn is "{action}" then
                return "action"
            end if
            return "dismiss"
        on error errMsg number errNum
            return "error:" & errNum & ":" & errMsg
        end try"#,
        body = body_safe,
        title = title_safe,
        action = action_safe,
        icon = icon_clause,
    );

    let user = match console_user() {
        Some(u) => u,
        None => {
            log_helper(&format!(
                "[alert] no console user; skipping dialog for {}",
                meta.app_name
            ));
            return;
        }
    };
    let uid = match user.uid {
        Some(u) => u,
        None => return,
    };

    log_helper(&format!(
        "[alert] dispatching dialog into uid={} session for {}",
        uid, meta.app_name
    ));

    let output = Command::new("launchctl")
        .arg("asuser")
        .arg(uid.to_string())
        .arg("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let clicked_action = match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let trimmed = stdout.trim();
            log_helper(&format!("[alert] dialog result: {}", trimmed));
            trimmed == "action"
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            log_helper(&format!("[alert] osascript non-zero: {}", stderr.trim()));
            false
        }
        Err(e) => {
            log_helper(&format!("[alert] osascript spawn failed: {}", e));
            false
        }
    };

    if clicked_action {
        // Open the browser's extensions page right in the user's
        // session. This is a best-effort — if it fails the user can
        // still click through the in-app banner.
        open_browser_extensions_page(meta, uid);
    }
}

#[cfg(target_os = "macos")]
fn fire_macos_notification(meta: &BrowserMeta, title: &str, body: &str) {
    let title_safe = applescript_escape(title);
    let body_safe = applescript_escape(body);
    let icon = macos_icon_clause();
    // Use a simple dialog with just a Dismiss button — the browser was
    // already closed, there's no action to take from here.
    let script = format!(
        r#"display dialog "{body}" with title "{title}" buttons {{"Dismiss"}} default button "Dismiss"{icon} giving up after 15"#,
        body = body_safe,
        title = title_safe,
        icon = icon,
    );
    let _ = run_osascript_asuser(&script);
    let _ = meta; // currently unused here, retained for future per-meta copy
}

/// Best-effort: figure out where ReDD Block's icon lives on disk and
/// emit the `with icon file …` clause that `display dialog` needs.
/// Returns an empty string if we can't find it — the dialog still
/// renders, just without our branding.
#[cfg(target_os = "macos")]
fn macos_icon_clause() -> String {
    let candidates = [
        "/Applications/ReDD Block.app/Contents/Resources/icon.icns",
    ];
    for p in &candidates {
        if std::path::Path::new(p).exists() {
            // AppleScript file specifiers use colon-separated HFS paths.
            let hfs = posix_to_hfs(p);
            return format!(" with icon file \"{}\"", hfs);
        }
    }
    String::new()
}

#[cfg(target_os = "macos")]
fn posix_to_hfs(path: &str) -> String {
    // `/Applications/ReDD Block.app/...` → `Macintosh HD:Applications:ReDD Block.app:...`
    // But AppleScript accepts a POSIX path via `POSIX file "…"` too,
    // which is simpler — use that.
    // Returning the POSIX path, caller wraps it as:
    //   with icon file (POSIX file "/abs/path")
    // Since the dialog syntax differs, we actually need a raw colon
    // path. Use the simpler alias form:
    //   path to application "ReDD Block"
    // Fallback: strip the leading slash and swap `/` → `:`
    let stripped = path.trim_start_matches('/');
    let mut s = String::from("Macintosh HD:");
    s.push_str(&stripped.replace('/', ":"));
    // AppleScript escape for colons: none needed — but backslashes and
    // double-quotes must still be escaped, which we do at the outer
    // layer via applescript_escape.
    s
}

#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    // Escape backslashes first, then double quotes — matches
    // AppleScript string-literal rules.
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn open_browser_extensions_page(meta: &BrowserMeta, uid: u32) {
    let url = match meta.label {
        "Chrome" => "chrome://extensions/?id=hhblkhfdjijdinijakbmcpkmdfhoadcd",
        "Brave" => "brave://extensions/?id=hhblkhfdjijdinijakbmcpkmdfhoadcd",
        "Edge" => "edge://extensions/?id=hhblkhfdjijdinijakbmcpkmdfhoadcd",
        "Firefox" => "about:addons",
        _ => return,
    };
    // On macOS `open -a "App Name" "url"` opens the URL in that
    // specific browser without forcing it to foreground.
    let _ = Command::new("launchctl")
        .arg("asuser")
        .arg(uid.to_string())
        .arg("/usr/bin/open")
        .arg("-a")
        .arg(meta.app_name)
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// ---------- Windows -------------------------------------------------------

#[cfg(target_os = "windows")]
fn fire_windows_dialog(meta: &BrowserMeta, title: &str, body: &str, action_button: &str) {
    // Use PowerShell's Windows Forms MessageBox — no external
    // dependency, no toast infrastructure, same process context as
    // the logged-in user.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // OK/Cancel maps to [action_button, Dismiss]; we pass the labels
    // through by using custom MessageBox buttons via WinForms.
    let ps = format!(
        r#"Add-Type -AssemblyName PresentationFramework;
[System.Windows.MessageBox]::Show(
    '{body}',
    '{title}',
    'OKCancel',
    'Warning') | Out-File -FilePath $env:TEMP\redd-alert.txt"#,
        body = ps_escape(body),
        title = ps_escape(title),
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    // If the user clicked OK (our "action" button) open the extensions
    // page. Otherwise just move on.
    let clicked_action = match output {
        Ok(out) => {
            let result = std::fs::read_to_string(std::env::temp_dir().join("redd-alert.txt"))
                .unwrap_or_default();
            let _ = std::fs::remove_file(std::env::temp_dir().join("redd-alert.txt"));
            let _ = out;
            result.trim().eq_ignore_ascii_case("OK")
        }
        Err(e) => {
            log_helper(&format!("[alert] powershell spawn failed: {}", e));
            false
        }
    };

    let _ = action_button; // label is currently driven by WinForms locale
    if clicked_action {
        open_browser_extensions_page_windows(meta);
    }
}

#[cfg(target_os = "windows")]
fn fire_windows_notification(title: &str, body: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let ps = format!(
        r#"Add-Type -AssemblyName PresentationFramework;
[System.Windows.MessageBox]::Show('{body}','{title}','OK','Information') | Out-Null"#,
        body = ps_escape(body),
        title = ps_escape(title),
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(target_os = "windows")]
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn open_browser_extensions_page_windows(meta: &BrowserMeta) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let (exe, url) = match meta.label {
        "Chrome" => ("chrome.exe", "chrome://extensions/?id=hhblkhfdjijdinijakbmcpkmdfhoadcd"),
        "Brave" => ("brave.exe", "brave://extensions/?id=hhblkhfdjijdinijakbmcpkmdfhoadcd"),
        "Edge" => ("msedge.exe", "edge://extensions/?id=hhblkhfdjijdinijakbmcpkmdfhoadcd"),
        "Firefox" => ("firefox.exe", "about:addons"),
        _ => return,
    };
    let _ = Command::new("cmd")
        .args(["/C", "start", "", exe, url])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn log_helper(msg: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("[{}] {}", now, msg);
    let _ = std::io::stdout().flush();
}
