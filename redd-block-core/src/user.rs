//! Console-user resolution.
//!
//! The ReDD Block helper daemon runs as `root` on macOS (LaunchDaemon,
//! `RunAtLoad`), so `dirs::home_dir()` returns `/var/root` rather than the
//! actual logged-in user's home directory. Browser preferences, the
//! native-host heartbeat stamps, and AppleScript dialogs *all* need to talk
//! to the logged-in user's session — so the helper must know who that is
//! and where their home directory lives.
//!
//! On Windows the helper runs as the logged-in user already (scheduled
//! task with `SC=ONLOGON` + `RL=HIGHEST`), so `dirs::home_dir()` is the
//! correct answer and no resolution is needed.
//!
//! On Linux we follow the same convention as macOS — if the process is
//! root, resolve the console user via `/dev/console`; otherwise fall back
//! to `dirs::home_dir()`.
//!
//! Every API in here is best-effort: if we can't figure out the console
//! user we return `None` and the caller is expected to fall back to the
//! current process's own home dir. In dev (`cargo run`), the helper is
//! typically invoked as the developer, so this fallback does the right
//! thing.

use std::path::PathBuf;

/// Opaque view of the currently-logged-in console user. The helper uses
/// this to read their browser preferences, find their heartbeat stamps,
/// and dispatch GUI alerts into their Aqua session (`launchctl asuser
/// <uid>`).
#[derive(Debug, Clone)]
pub struct ConsoleUser {
    /// Unix UID (macOS / Linux). `None` on Windows.
    pub uid: Option<u32>,
    /// Home directory as an absolute path (e.g. `/Users/ulyngs`,
    /// `C:\Users\ulyngs`). Non-empty on success.
    pub home: PathBuf,
    /// Short login name (e.g. `ulyngs`). Best-effort — may be empty.
    pub name: String,
}

/// Resolve the effective user's home directory. On macOS / Linux, if the
/// current process is root, prefer the console user's home; otherwise
/// return the current process's own `dirs::home_dir()`. On Windows we
/// always use `dirs::home_dir()`.
///
/// Used throughout browser-probing helpers so the same code can run in
/// either the Tauri app (as the user) or the helper daemon (as root).
pub fn effective_user_home() -> Option<PathBuf> {
    if let Some(u) = console_user() {
        if u.home.as_os_str().len() > 0 {
            return Some(u.home);
        }
    }
    dirs::home_dir()
}

/// Return the console user if the current process can identify one and
/// its UID differs from the process's own (i.e. we're running as root
/// and there's a meaningful "user" to impersonate). Returns `None` on
/// Windows, and when there's no logged-in console user (headless boot).
pub fn console_user() -> Option<ConsoleUser> {
    #[cfg(target_os = "macos")]
    {
        return macos_console_user();
    }

    #[cfg(target_os = "linux")]
    {
        return linux_console_user();
    }

    #[cfg(target_os = "windows")]
    {
        return None;
    }

    #[allow(unreachable_code)]
    None
}

#[cfg(target_os = "macos")]
fn macos_console_user() -> Option<ConsoleUser> {
    // Prefer the owner of /dev/console — this is the classic way to
    // identify the logged-in GUI user on macOS and matches what
    // `launchctl asuser` expects.
    let uid = stat_owner_uid("/dev/console")?;
    // If we happen to be running as this user already, still return the
    // info so callers can use `uid` / `home` unconditionally.
    let entry = passwd_for_uid(uid)?;
    Some(ConsoleUser {
        uid: Some(uid),
        home: entry.home,
        name: entry.name,
    })
}

#[cfg(target_os = "linux")]
fn linux_console_user() -> Option<ConsoleUser> {
    // /dev/console ownership also works on Linux, but in many distros the
    // console user is better found via $SUDO_USER / logind. Keep it
    // simple: try /dev/console first, fall back to the current euid.
    let uid = stat_owner_uid("/dev/console").unwrap_or_else(|| unsafe { libc::getuid() });
    let entry = passwd_for_uid(uid)?;
    Some(ConsoleUser {
        uid: Some(uid),
        home: entry.home,
        name: entry.name,
    })
}

#[cfg(not(target_os = "windows"))]
fn stat_owner_uid(path: &str) -> Option<u32> {
    use std::ffi::CString;
    let c = CString::new(path).ok()?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: we pass a valid null-terminated C string + pointer to
    // zero-initialised stat storage. `stat` populates it on success.
    let rc = unsafe { libc::stat(c.as_ptr(), &mut stat) };
    if rc != 0 {
        return None;
    }
    Some(stat.st_uid as u32)
}

#[cfg(not(target_os = "windows"))]
struct PasswdEntry {
    name: String,
    home: PathBuf,
}

#[cfg(not(target_os = "windows"))]
fn passwd_for_uid(uid: u32) -> Option<PasswdEntry> {
    use std::ffi::CStr;
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf: Vec<i8> = vec![0; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: getpwuid_r fills `pwd` + writes string bodies into `buf`.
    // We keep `buf` alive for the life of the returned struct view.
    let rc = unsafe {
        libc::getpwuid_r(
            uid as libc::uid_t,
            &mut pwd,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        )
    };
    if rc != 0 || result.is_null() {
        return None;
    }
    let name = unsafe { CStr::from_ptr(pwd.pw_name) }
        .to_string_lossy()
        .into_owned();
    let home_str = unsafe { CStr::from_ptr(pwd.pw_dir) }
        .to_string_lossy()
        .into_owned();
    if home_str.is_empty() {
        return None;
    }
    Some(PasswdEntry {
        name,
        home: PathBuf::from(home_str),
    })
}
