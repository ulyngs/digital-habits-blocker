// Legacy Windows watchdog diagnostics and uninstall cleanup.
// New tasks and script wrappers are no longer created (Defender issue #152).
// Existing installations keep their tasks until normal uninstall.

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
