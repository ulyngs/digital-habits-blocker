// Per-user Scheduled Task that respawns the app if the user kills it
// from Task Manager. Closes the bypass window to ~60 s without needing
// admin or a Windows Service.
//
// Layout (three files next to the exe):
//   - `redd-block-watchdog.cmd` — `tasklist` + `start ""`, only spawns
//     redd-block.exe if it isn't already running. Avoids duplicate
//     instances without needing tauri-plugin-single-instance.
//   - `redd-block-watchdog.vbs` — runs the .cmd with WScript.Shell.Run
//     `intWindowStyle = 0` (SW_HIDE). Routing through wscript.exe is
//     the canonical way to suppress the cmd-window flash when a
//     Scheduled Task fires a console action — `cmd.exe` (or even
//     `powershell -WindowStyle Hidden`) flashes a console because the
//     window is created before any hide flag is applied. wscript.exe
//     has no console at all, and SW_HIDE keeps the spawned cmd hidden.
//   - `\ReDD Blocker Watchdog` Scheduled Task: action is
//     `wscript.exe "<path>\redd-block-watchdog.vbs"`, every minute,
//     current user, no admin.
//
// The app calls `register()` at every startup so a tampered-with task
// (deleted by the user, stale path after manual relocation) gets
// reinstated. `unregister()` is called on `redd-block.exe --uninstall`
// and from the NSIS pre-uninstall hook, and removes both wrapper
// files plus the task.
//
// Limits: a determined user with Task Scheduler open can disable this
// task too. Real tamper-proofing requires kernel-mode protection,
// which the migration deliberately moved away from.

use std::path::{Path, PathBuf};

use crate::windows_process::hidden_command;

pub const TASK_NAME: &str = crate::product_identity::WATCHDOG_TASK_NAME;
const WRAPPER_CMD_FILENAME: &str = "redd-block-watchdog.cmd";
const WRAPPER_VBS_FILENAME: &str = "redd-block-watchdog.vbs";

fn wrapper_dir(exe: &Path) -> Option<PathBuf> {
    if crate::native_host_install::is_msix_packaged_exe_path(exe) {
        Some(crate::product_identity::windows_primary_local_product_dir()?.join("watchdog"))
    } else {
        exe.parent().map(|p| p.to_path_buf())
    }
}

fn delete_task(name: &str) {
    let _ = hidden_command("schtasks")
        .args(["/Delete", "/TN", name, "/F"])
        .output();
}

fn delete_legacy_tasks() {
    for name in crate::product_identity::LEGACY_WATCHDOG_TASK_NAMES {
        delete_task(name);
    }
}

fn write_wrappers(exe: &Path) -> std::io::Result<PathBuf> {
    let dir =
        wrapper_dir(exe).ok_or_else(|| std::io::Error::other("cannot resolve wrapper dir"))?;
    std::fs::create_dir_all(&dir)?;

    let exe_name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("redd-block.exe");
    let exe_path = exe.to_string_lossy().replace('"', "\"\"");

    // When the Store package is removed, the WindowsApps exe vanishes but
    // the per-minute task may still fire. Avoid `start` on a missing path
    // (Windows shows "The specified path does not exist"). Run `--uninstall`
    // from the staged copy when present, then delete this task.
    let missing_exe_block = if crate::native_host_install::is_msix_packaged_exe_path(exe) {
        let staged = crate::native_host_install::staged_native_host_exe()
            .map(|p| p.to_string_lossy().replace('"', "\"\""))
            .unwrap_or_default();
        let staged_uninstall = if staged.is_empty() {
            String::new()
        } else {
            format!("\"{staged}\" --uninstall >nul 2>&1\r\n")
        };
        format!(
            "if not exist \"{exe_path}\" (\r\n\
             {staged_uninstall}\
             schtasks /Delete /TN \"{task}\" /F >nul 2>&1\r\n\
             exit /b 0\r\n\
             )\r\n",
            task = TASK_NAME,
        )
    } else {
        format!(
            "if not exist \"{exe_path}\" (\r\n\
             schtasks /Delete /TN \"{task}\" /F >nul 2>&1\r\n\
             exit /b 0\r\n\
             )\r\n",
            task = TASK_NAME,
        )
    };

    // Use an absolute exe path so wrappers work when stored outside the
    // install dir (Microsoft Store / MSIX cannot write under WindowsApps).
    let cmd_body = format!(
        "@echo off\r\n\
         {missing_exe_block}\
         tasklist /FI \"IMAGENAME eq {exe}\" /NH | find /I \"{exe}\" >nul\r\n\
         if errorlevel 1 start \"\" \"{exe_path}\"\r\n",
        missing_exe_block = missing_exe_block,
        exe = exe_name,
        exe_path = exe_path,
    );
    std::fs::write(dir.join(WRAPPER_CMD_FILENAME), cmd_body)?;

    // VBS resolves its own dir + invokes the sibling .cmd hidden.
    // The four-double-quote sequence `""""` is a VBS literal for a
    // single `"` — used to wrap the .cmd path in case it contains
    // spaces (e.g. `C:\Program Files\ReDD Blocker\`).
    let vbs_body: String = [
        r#"dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)"#,
        &format!(
            r#"CreateObject("WScript.Shell").Run """" & dir & "\{cmd}""", 0, False"#,
            cmd = WRAPPER_CMD_FILENAME
        ),
        "",
    ]
    .join("\r\n");
    let vbs_path = dir.join(WRAPPER_VBS_FILENAME);
    std::fs::write(&vbs_path, vbs_body)?;
    Ok(vbs_path)
}

/// Idempotent: writes the wrapper scripts and (re)registers the task.
/// Best-effort — failures are logged but never propagated, since a
/// missing watchdog shouldn't block the app from running.
pub fn register() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("watchdog: cannot resolve current_exe: {e}");
            return;
        }
    };

    let vbs_path = match write_wrappers(&exe) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("watchdog: failed to write wrappers: {e}");
            return;
        }
    };

    // Task action invokes wscript.exe with the .vbs — no console flash.
    delete_legacy_tasks();
    let task_run = format!("wscript.exe \"{}\"", vbs_path.display());
    let out = hidden_command("schtasks")
        .args([
            "/Create", "/TN", TASK_NAME, "/TR", &task_run,
            // Every 5 minutes rather than every 1: the watchdog only
            // needs to respawn the app if the user has killed it, which
            // is rare. A 1-minute cadence meant a Task Scheduler wake +
            // wscript/cmd/tasklist process spawn every 60s forever, even
            // fully idle — a steady battery drain on laptops (it also
            // hides from the app's own CPU line, being a separate
            // process). 5 minutes keeps self-heal effective while cutting
            // the wake rate 5x.
            "/SC", "MINUTE", "/MO", "5", "/RL", "LIMITED", "/F",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => log::info!("watchdog: task registered ({task_run})"),
        Ok(o) => log::warn!(
            "watchdog: schtasks /Create exit {:?}: {}",
            o.status.code(),
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Err(e) => log::warn!("watchdog: schtasks failed to spawn: {e}"),
    }
}

/// True if the per-user Scheduled Task is currently registered with
/// the Task Scheduler. Best-effort — failures (schtasks not found,
/// permission denied) are treated as "not present" rather than
/// crashing the diagnostics readout.
pub fn is_registered() -> bool {
    hidden_command("schtasks")
        .args(["/Query", "/TN", TASK_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Idempotent: removes the task and both wrapper scripts if present.
pub fn unregister() {
    delete_task(TASK_NAME);
    delete_legacy_tasks();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = wrapper_dir(&exe) {
            let _ = std::fs::remove_file(dir.join(WRAPPER_CMD_FILENAME));
            let _ = std::fs::remove_file(dir.join(WRAPPER_VBS_FILENAME));
        }
        // Also scrub legacy MSIX wrapper dirs from prior product folder names.
        for legacy in crate::product_identity::windows_legacy_local_product_dirs() {
            let dir = legacy.join("watchdog");
            let _ = std::fs::remove_file(dir.join(WRAPPER_CMD_FILENAME));
            let _ = std::fs::remove_file(dir.join(WRAPPER_VBS_FILENAME));
        }
    }
}
