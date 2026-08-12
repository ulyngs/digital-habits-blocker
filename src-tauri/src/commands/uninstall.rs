//! macOS in-app uninstall.
//!
//! Removes the launch-at-login entry, scrubs per-browser
//! native-messaging manifests, moves the .app bundle to the user's
//! Trash, and exits. User data in
//! `~/Library/Application Support/com.reddblock/` and
//! `~/Library/Preferences/com.reddblock.plist` is preserved so a future
//! reinstall picks the user's blocklists / schedules / settings back
//! up.
//!
//! Why an in-app command (and only on macOS):
//!   - macOS .pkg installers are install-only by design — they don't
//!     ship a sibling uninstaller, and the menu-bar accessory model +
//!     applicationShouldTerminate interceptor mean a user can't quit
//!     the app or drag-trash the bundle while it's running. So uninstall
//!     has to be self-driven from inside the app.
//!   - Windows uninstall lives in `windows/hooks.nsh`'s
//!     NSIS_HOOK_PREUNINSTALL macro, driven by the OS-provided
//!     uninstaller (Settings → Apps → Uninstall). No in-app command is
//!     needed there.
//!
//! Order matters:
//!   1. Disable autostart and scrub the LaunchAgent plist FIRST. If we
//!      kept the LaunchAgent live, deleting the bundle would just leave
//!      it pointing at a missing path, and the next login would log a
//!      launchd error.
//!   2. Remove per-browser native-messaging manifests so browsers stop
//!      trying to spawn the native host.
//!   3. Try `NSFileManager.trashItemAtURL:` synchronously, in-process.
//!      This is Apple's modern Trash API and goes through the same
//!      privileged code path Finder uses, *without* needing the
//!      Automation TCC permission that AppleScript-driven Finder calls
//!      do. In the common case this is the only step that runs, so
//!      the user sees no permission prompt at all. We can rename the
//!      bundle while still executing inside it: macOS rename(2)
//!      preserves the open executable's inode, and we drop our own
//!      reference to it ~200 ms later when the process exits.
//!   4. If `trashItemAtURL:` failed (rare — typically only on
//!      non-admin accounts where /Applications/ isn't user-writable,
//!      or when stricter App Management TCC kicks in), spawn a
//!      detached `bash` that waits a moment and then tries
//!      `mv → ~/.Trash`, then a Finder AppleScript, then `rm -rf`.
//!      The Finder fallback DOES surface an Automation TCC prompt
//!      ("ReDD Blocker would like to control Finder") — we warn the
//!      user about this in the uninstall confirmation dialog so it
//!      isn't a surprise. The 2 s sleep in the script gives this
//!      process time to exit so any further attempts run cleanly.
//!   5. Exit. Frontend should already be showing a "Goodbye…" UI before
//!      invoking this command — the IPC reply may or may not make it
//!      back depending on timing.
//!
//! Diagnostics:
//!   The detached uninstall script writes a timestamped trace to
//!   `~/Library/Logs/com.reddblock/uninstall.log`, which is bundled
//!   into the Diagnostics zip and survives the bundle move (it lives
//!   under the user's home, not inside the .app). If a user reports
//!   "I uninstalled but the app is still in /Applications", that file
//!   will say which step failed and why. The synchronous
//!   `trashItemAtURL:` outcome is also logged via `log::info!` /
//!   `log::warn!` so it appears in the regular Tauri log.

#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

#[cfg(target_os = "macos")]
use crate::native_host_install;

/// Disable autostart, scrub native-messaging manifests + LaunchAgent
/// plist(s), and schedule a detached self-delete of the .app bundle.
/// Returns immediately; the actual exit happens on a short timer so the
/// IPC reply has a chance to make it back to the frontend before the
/// process drops.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn uninstall_self_macos(
    app: tauri::AppHandle,
    delete_user_data: Option<bool>,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    log::info!(
        "uninstall_self_macos: starting (delete_user_data={})",
        delete_user_data.unwrap_or(false)
    );

    if delete_user_data.unwrap_or(false) {
        super::data::wipe_user_data(&app);
    }

    // 1. Disable launch-at-login. The plugin removes the LaunchAgent
    //    plist as part of `disable()` when running in MacosLauncher::
    //    LaunchAgent mode. Belt-and-braces: also scrub by glob below
    //    in case the plugin and the on-disk plist name drift apart in
    //    a future Tauri version.
    if let Err(e) = app.autolaunch().disable() {
        log::warn!("uninstall_self_macos: autostart.disable failed: {e}");
    }
    scrub_all_autostart_plists();

    // 2. Remove per-browser native-messaging manifests + their
    //    enclosing NativeMessagingHosts directories if empty. Same
    //    cleanup the Windows NSIS preuninstall hook runs via
    //    `redd-block.exe --uninstall`.
    if let Err(e) = native_host_install::uninstall() {
        log::warn!("uninstall_self_macos: native-host uninstall failed: {e}");
    }

    // 3. Remove the External-Extensions hints we dropped at install
    //    time so a clean uninstall doesn't leave hooks pointing at a
    //    non-existent app. The extension itself stays installed in
    //    each browser — we only own the auto-install hint.
    if let Err(e) = crate::extension_install::uninstall() {
        log::warn!("uninstall_self_macos: extension-install uninstall failed: {e}");
    }

    // 3. Resolve the .app bundle path from the running executable
    //    rather than hardcoding `/Applications/ReDD Blocker.app` so a
    //    copy launched from elsewhere (rare, but happens during dev)
    //    deletes the right bundle.
    let bundle =
        app_bundle_path().ok_or_else(|| "could not resolve app bundle path".to_string())?;

    // 4. Try the prompt-free path first: NSFileManager.trashItemAtURL:.
    //    This is Apple's recommended way to move files to Trash and
    //    does NOT require Automation TCC. Renaming a bundle that is
    //    currently executing is safe — POSIX rename(2) preserves the
    //    inode for any open file descriptor (including the running
    //    binary), and we exit ~200 ms later anyway.
    match try_trash_via_nsfilemanager(&bundle) {
        Ok(()) => {
            log::info!("uninstall_self_macos: bundle moved to Trash via NSFileManager: {bundle}");
        }
        Err(e) => {
            // Fall back to the detached bash script (mv → osascript →
            // rm). This is the path that may surface the
            // "ReDD Blocker would like to control Finder" Automation
            // prompt — the user has been warned about it in the
            // confirmation dialog (see `uninstall-confirm-modal` in
            // `src/app.js`).
            log::warn!(
                "uninstall_self_macos: NSFileManager.trashItemAtURL failed ({e}); spawning bash fallback for {bundle}"
            );
            spawn_self_delete(&bundle).map_err(|e| format!("self-delete spawn failed: {e}"))?;
        }
    }

    // 5. Spawn a detached killer for any native-messaging host children
    //    that browsers spawned from this bundle. These are siblings of
    //    ours (parented to Chrome / Firefox / Edge / Brave), so quitting
    //    the main app doesn't take them down — they linger in Activity
    //    Monitor until the browser closes the stdio pipe. The killer
    //    waits ~1 s for our own PID to exit first, so it's structurally
    //    impossible for it to land on us; matches by full bundle path
    //    so a parallel `cargo run` dev build at `target/debug/redd-block`
    //    is left alone.
    if let Err(e) = spawn_native_host_killer(&bundle) {
        log::warn!("uninstall_self_macos: native-host killer spawn failed: {e}");
    }

    // 6. Exit on a short timer so the IPC reply lands on the frontend
    //    before this process disappears.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(200));
        log::info!("uninstall_self_macos: exiting now");
        std::process::exit(0);
    });

    Ok(())
}

/// Spawn a detached `bash` that waits for the GUI process to exit, then
/// `pkill`s any remaining redd-block processes spawned from this bundle.
/// These are browser-parented native-messaging host children (same
/// binary, invoked by Chrome/Firefox/Edge/Brave via stdio); the main
/// app's `std::process::exit` doesn't reach them.
///
/// Why deferred + path-matched:
///   - Deferred so the kill runs only after our own PID is gone, which
///     makes accidental self-kill impossible.
///   - Path-matched (the bundle's MacOS dir, not just the `redd-block`
///     basename) so a developer running `cargo run` from
///     `target/debug/redd-block` isn't taken out alongside an installed
///     copy. After NSFileManager moves the bundle to `~/.Trash/`, the
///     child processes' argv still reflects their launched path
///     (containing `ReDD Blocker.app/Contents/MacOS/redd-block`), so
///     matching on that substring catches them whether the bundle has
///     been trashed yet or not.
#[cfg(target_os = "macos")]
fn spawn_native_host_killer(bundle: &str) -> std::io::Result<()> {
    // Pull just the bundle name (e.g. "ReDD Blocker.app") so the match
    // works both pre- and post-trash. We don't want to pin to
    // /Applications/ — users sometimes install elsewhere.
    let bundle_name = std::path::Path::new(bundle)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Digital Habits Blocker.app");
    let match_pattern = format!("{bundle_name}/Contents/MacOS/redd-block");

    let log_path = uninstall_log_path();
    let log_q = log_path.replace('\'', r"'\''");
    let pat_q = match_pattern.replace('\'', r"'\''");

    let script = format!(
        r#"exec >>'{log_q}' 2>&1
echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] native-host killer starting; pattern='{pat_q}'"
sleep 1
PIDS=$(/usr/bin/pgrep -f '{pat_q}' || true)
if [ -z "$PIDS" ]; then
    echo "  no matching processes"
    exit 0
fi
echo "  matched pids: $PIDS"
/bin/kill $PIDS 2>>'{log_q}' || true
sleep 1
STRAGGLERS=$(/usr/bin/pgrep -f '{pat_q}' || true)
if [ -n "$STRAGGLERS" ]; then
    echo "  still alive after TERM: $STRAGGLERS; sending KILL"
    /bin/kill -KILL $STRAGGLERS 2>>'{log_q}' || true
fi
echo "  done"
exit 0
"#,
    );

    Command::new("/bin/bash")
        .arg("-c")
        .arg(&script)
        .arg("redd-block-host-killer")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

/// Move the bundle to `~/.Trash/` using `NSFileManager.trashItemAtURL:`,
/// the same API Finder uses internally. No subprocess, no AppleScript,
/// no Automation TCC prompt. Returns the underlying `NSError`'s
/// `localizedDescription` on failure so it can be logged for
/// diagnostics.
#[cfg(target_os = "macos")]
fn try_trash_via_nsfilemanager(bundle: &str) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let manager = NSFileManager::defaultManager();
    let path_ns = NSString::from_str(bundle);
    // `isDirectory: true` because a `.app` bundle is a directory; the
    // flag lets NSURL skip a stat() to figure that out.
    let url = NSURL::fileURLWithPath_isDirectory(&path_ns, true);

    match manager.trashItemAtURL_resultingItemURL_error(&url, None) {
        Ok(()) => Ok(()),
        Err(err) => Err(err.localizedDescription().to_string()),
    }
}

/// Resolve the path to the running app bundle (e.g.
/// "/Applications/ReDD Blocker.app"). Walks up from the executable
/// location until we find the `.app` parent. Returns `None` if the
/// binary isn't inside an `.app` (e.g. a debug build run via
/// `cargo run`), in which case the caller should bail rather than
/// rm-rf'ing some random path.
#[cfg(target_os = "macos")]
fn app_bundle_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let mut p = exe.as_path();
    while let Some(parent) = p.parent() {
        if parent.extension().map(|e| e == "app").unwrap_or(false) {
            return parent.to_str().map(String::from);
        }
        p = parent;
    }
    None
}

/// Remove stale user LaunchAgents from Fristed / ReDD Block / older
/// ReDD Blocker builds. Idempotent — silently ignores missing files
/// or dirs. We don't trust any one filename pattern because
/// `tauri-plugin-autostart`'s plist naming has shifted between
/// versions (e.g. `Fristed.plist` vs `redd-block.plist`).
///
/// Legacy plists only — safe to call at startup. The uninstall path
/// uses [`scrub_all_autostart_plists`], which also removes the current
/// bundle's plist.
#[cfg(target_os = "macos")]
// Called from the release-only autostart bootstrap in lib.rs, so it reads as
// dead in a debug build.
#[allow(dead_code)]
pub(crate) fn scrub_stale_autostart_plists() {
    scrub_autostart_plists(false);
}

/// Uninstall-only: also removes the CURRENT bundle's LaunchAgent.
/// Never call at startup — see `should_scrub_autostart_plist`.
#[cfg(target_os = "macos")]
pub(crate) fn scrub_all_autostart_plists() {
    scrub_autostart_plists(true);
}

#[cfg(target_os = "macos")]
fn scrub_autostart_plists(include_current: bool) {
    use std::fs;
    use std::io::Read;

    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join("Library/LaunchAgents");
    let Ok(rd) = fs::read_dir(&dir) else {
        return;
    };
    let uid = unsafe { libc::getuid() };
    let domain = format!("gui/{uid}");

    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("plist") {
            continue;
        }
        let Some(filename) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let mut content = String::new();
        if let Ok(mut f) = fs::File::open(&path) {
            let _ = f.read_to_string(&mut content);
        }
        if !should_scrub_autostart_plist(filename, &content, include_current) {
            continue;
        }
        log::info!(
            "scrub_autostart_plists(include_current={include_current}): bootout + remove {}",
            path.display()
        );
        let _ = Command::new("launchctl")
            .args(["bootout", &domain, &path.to_string_lossy()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = fs::remove_file(&path);
    }
}

#[cfg(target_os = "macos")]
fn should_scrub_autostart_plist(filename: &str, content: &str, include_current: bool) -> bool {
    let lower = filename.to_ascii_lowercase();
    if lower.contains("reddblock") || lower.contains("redd-block") {
        return true;
    }
    // Fristed-era autostart used the product name verbatim as the
    // LaunchAgent filename/label — avoid a broad *fristed* substring
    // match that could catch unrelated plists.
    if lower == "fristed.plist" {
        return true;
    }
    if content.contains("/Applications/Fristed.app")
        || content.contains("/Applications/ReDD Block.app")
        || content.contains("/Applications/ReDD Blocker.app")
    {
        return true;
    }
    // The CURRENT bundle's plist may only be scrubbed on uninstall
    // (include_current). The startup self-heal must never match it:
    // when the app was launched at login *by* that plist, `launchctl
    // bootout` on it terminates the running job — i.e. the app kills
    // itself mid-startup and launch-at-login silently stops working.
    include_current
        && content.contains(&format!(
            "/Applications/{}.app",
            crate::product_identity::PRODUCT_DIR_NAME
        ))
}

/// Spawn a detached `bash` that waits a couple of seconds for our
/// process to exit, then moves the .app bundle to the user's Trash
/// (with two fallbacks if the rename fails).
///
/// Strategy, in order:
///   1. `mv -f "$BUNDLE" "$HOME/.Trash/<basename>.<pid>"` — usually
///      succeeds. On a typical Mac the user is in the `admin` group
///      and `/Applications` is `0775 root:admin`, so the user has
///      unlink rights via group membership. The destination filename
///      gets a `$$` suffix to avoid colliding with an older copy
///      already sitting in Trash.
///   2. AppleScript via Finder
///      (`tell application "Finder" to delete POSIX file …`). Goes
///      through Finder's privileges and may surface an Automation
///      prompt the first time. Useful if `mv` failed because of an
///      ownership oddity but Finder can still see the bundle.
///   3. `rm -rf` — last-ditch. Will fail on macOS 14+ if the user
///      hasn't granted ReDD Blocker "App Management" permission, but
///      worth trying for older macOS / unsigned dev bundles where
///      it's the only thing that works.
///
/// All steps log to ~/Library/Logs/com.reddblock/uninstall.log so a
/// failed uninstall can be diagnosed after the fact.
///
/// We pass the bundle path as a positional `$1` rather than splicing
/// it into the script body, which keeps the bash script free of
/// shell-quoting hazards no matter what's in the path.
///
/// Stdio is fully nulled to avoid the child holding open a TTY or
/// inheriting our log file descriptors (the script re-opens its own
/// log file via `exec >>`). We don't `setsid` because Tauri's
/// `process::exit(0)` on macOS reliably reparents children to launchd
/// and the child has no controlling terminal.
#[cfg(target_os = "macos")]
fn spawn_self_delete(bundle: &str) -> std::io::Result<()> {
    // Shell-quote the log path. We don't quote the bundle here because
    // we pass it as `$1`; bash's own arg parsing handles spaces and
    // quotes verbatim.
    let log_path = uninstall_log_path();
    let log_q = log_path.replace('\'', r"'\''");

    let script = format!(
        r#"exec >>'{log_q}' 2>&1
echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] uninstall starting; bundle=$1"
sleep 2

BUNDLE="$1"
if [ ! -e "$BUNDLE" ]; then
    echo "  bundle path doesn't exist; nothing to do"
    exit 0
fi
BASENAME="$(basename "$BUNDLE")"
TRASH_DEST="$HOME/.Trash/$BASENAME.$$"

echo "  step 1: mv -> $TRASH_DEST"
if mv -f "$BUNDLE" "$TRASH_DEST" 2>>'{log_q}'; then
    echo "  step 1 OK"
    exit 0
fi
echo "  step 1 failed (exit=$?)"

echo "  step 2: osascript (Finder delete POSIX file)"
APPLE_PATH=$(printf '%s' "$BUNDLE" | sed 's/"/\\"/g')
if /usr/bin/osascript -e "tell application \"Finder\" to delete POSIX file \"$APPLE_PATH\"" 2>>'{log_q}'; then
    echo "  step 2 OK"
    exit 0
fi
echo "  step 2 failed (exit=$?)"

echo "  step 3: rm -rf"
if /bin/rm -rf "$BUNDLE" 2>>'{log_q}'; then
    echo "  step 3 OK"
    exit 0
fi
echo "  step 3 failed (exit=$?)"

echo "  all attempts failed; bundle still at $BUNDLE"
exit 1
"#,
    );

    Command::new("/bin/bash")
        .arg("-c")
        .arg(&script)
        // $0 — convenient label in `ps` for anyone debugging.
        .arg("redd-block-uninstall")
        // $1 — the bundle path; consumed inside the script as "$BUNDLE".
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

/// Resolve the path of `~/Library/Logs/com.reddblock/uninstall.log`,
/// creating the parent dir if needed. Falls back to
/// `/tmp/redd-block-uninstall.log` if the home dir is somehow
/// unavailable. Lives under the user's home rather than inside the
/// .app so it survives the bundle move and shows up in the
/// Diagnostics zip alongside the other logs.
#[cfg(target_os = "macos")]
fn uninstall_log_path() -> String {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join("Library/Logs/com.reddblock");
        let _ = std::fs::create_dir_all(&dir);
        return dir.join("uninstall.log").to_string_lossy().into_owned();
    }
    "/tmp/redd-block-uninstall.log".to_string()
}
