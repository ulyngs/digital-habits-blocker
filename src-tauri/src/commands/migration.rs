// First-launch migration off the v1.x privileged-helper stack.
//
// Goal: strip the daemon-managed lines from the system hosts file and
// remove the legacy launchd plist / scheduled task + helper binary,
// in a way that is safe, atomic, and reversible if something goes
// wrong mid-flight.
//
// Design (matches the approved plan in the planning file):
//
// A. Detect — markers present OR legacy daemon installed?
//    No → no-op, stamp version, done.
// B. Probe admin via a cheap elevated `true` call. User cancels →
//    abort with `migration_pending=true`, no state touched.
// C. Inside ONE elevated script (set -e or PowerShell with
//    $ErrorActionPreference='Stop'), in this order:
//      1. snapshot /etc/hosts to <app-data>/backups/hosts.<ts>
//      2. validate snapshot (non-empty, contains `localhost`)
//      3. compute cleaned hosts content (prefer the legacy
//         /etc/hosts.redd-backup if it's sane; else awk-strip)
//      4. validate cleaned content (non-empty, contains `localhost`)
//      5. atomic temp-file + rename onto /etc/hosts
//      6. flush DNS
//      7. ONLY NOW remove daemon (bootout + rm plist + rm binary
//         + rm /var/lib/redd-block/helper-state.json — the directory
//         itself stays; see `legacy_artefacts_present` below)
//      8. ONLY NOW remove the legacy /etc/hosts.redd-backup
//      9. write a status marker so Rust knows the script reached
//         the end
// D. Rust re-validates from userspace (markers gone, plist gone),
//    and only then stamps `settings.migrationRanAtVersion`.
//
// Any failure between B and D leaves the user with an intact original
// hosts file and surfaces a "Migration incomplete" banner. The
// migration is fully retryable — the next launch (or the banner CTA)
// re-runs the whole sequence.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};

use serde::Serialize;

// Snapshot of "was migration pending when this process launched?".
// Lazily computed on first read, then frozen for the rest of the
// process. Lets the frontend distinguish "fresh install" from
// "we just upgraded" even after the migration script has cleared
// the residue mid-launch.
//
// Encoded as: -1 = uninitialised, 0 = false, 1 = true.
static MIGRATION_WAS_PENDING_AT_LAUNCH: AtomicI8 = AtomicI8::new(-1);
static SNAPSHOT_INIT: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "system-test")]
fn snapshot_initial_state() -> bool {
    false
}

#[cfg(not(feature = "system-test"))]
fn snapshot_initial_state() -> bool {
    if SNAPSHOT_INIT.load(Ordering::Acquire) {
        return MIGRATION_WAS_PENDING_AT_LAUNCH.load(Ordering::Acquire) == 1;
    }
    let pending = migration_pending_uncached();
    let val = if pending { 1 } else { 0 };
    let _ = MIGRATION_WAS_PENDING_AT_LAUNCH.compare_exchange(
        -1,
        val,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
    SNAPSHOT_INIT.store(true, Ordering::Release);
    MIGRATION_WAS_PENDING_AT_LAUNCH.load(Ordering::Acquire) == 1
}

const BEGIN_MARKER: &str = "# === BEGIN REDD BLOCK (reddfocus.org) ===";
const END_MARKER: &str = "# === END REDD BLOCK (reddfocus.org) ===";
const LEGACY_BEGIN: &str = "# ReDD Block Start";
const LEGACY_END: &str = "# ReDD Block End";

const STATUS_OK: &str = "ok";

// ---- Detection -----------------------------------------------------------

fn hosts_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/etc/hosts")
    }
}

fn legacy_hosts_backup_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts.redd-backup")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/etc/hosts.redd-backup")
    }
}

fn hosts_has_markers(content: &str) -> bool {
    content.lines().any(|l| {
        let t = l.trim();
        t == BEGIN_MARKER || t == END_MARKER || t == LEGACY_BEGIN || t == LEGACY_END
    })
}

fn legacy_artefacts_present() -> bool {
    // We only count daemon-specific files as residue. The shared data
    // dir (/var/lib/redd-block on macOS, ProgramData\<product> on
    // Windows) intentionally stays: nothing writes it any more, but
    // commands::data::import_shared_data_into_per_user still reads the
    // user's redd-block-data.json out of it, and accounts that have not
    // launched the new build yet have not imported theirs.
    #[cfg(target_os = "macos")]
    {
        let paths = [
            "/Library/LaunchDaemons/com.redd.block.helper.plist",
            "/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist",
            "/Library/PrivilegedHelperTools/com.redd.block.helper",
            "/var/lib/redd-block/helper-state.json",
        ];
        paths.iter().any(|p| Path::new(p).exists())
    }
    #[cfg(target_os = "windows")]
    {
        let mut dirs = crate::product_identity::windows_legacy_shared_dirs();
        dirs.push(crate::product_identity::windows_primary_shared_dir());
        dirs.iter()
            .any(|dir| dir.join("helper-state.json").exists())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Returns true when there's any v1.x residue (hosts markers or
/// legacy artefacts) the migration still needs to clean up. Also
/// memoises the answer at first call so we can later report what
/// the state was at process launch (for the frontend's "we just
/// upgraded, show the welcome" gate).
pub fn migration_pending_sync() -> bool {
    let _ = snapshot_initial_state();
    migration_pending_uncached()
}

#[cfg(feature = "system-test")]
fn migration_pending_uncached() -> bool {
    false
}

#[cfg(not(feature = "system-test"))]
fn migration_pending_uncached() -> bool {
    let raw = std::fs::read_to_string(hosts_path()).unwrap_or_default();
    if hosts_has_markers(&raw) {
        return true;
    }
    legacy_artefacts_present()
}

#[tauri::command]
pub fn migration_pending() -> bool {
    migration_pending_sync()
}

/// True if there was v1.x residue when the process started, even if
/// the migration has since cleaned it up. The frontend uses this to
/// decide whether to show the post-cleanup "welcome to 2.0" screen.
#[tauri::command]
pub fn migration_was_pending_at_launch() -> bool {
    snapshot_initial_state()
}

/// True if this install has *ever* hosted the v1.x privileged
/// daemon — durable signal across launches, surviving the cleanup.
/// We use the existence of `/etc/hosts.redd-backup` (or its Windows
/// equivalent) as the fingerprint: that file is only ever written
/// by the v1.x daemon's `ensure_backup_exists` and is intentionally
/// preserved by the migration as a recovery copy. The frontend uses
/// it to decide whether to surface a persistent "behaviour has
/// changed" banner for upgraders, separate from the one-time
/// welcome overlay.
#[cfg(feature = "system-test")]
#[tauri::command]
pub fn user_came_from_v1x() -> bool {
    false
}

#[cfg(not(feature = "system-test"))]
#[tauri::command]
pub fn user_came_from_v1x() -> bool {
    legacy_hosts_backup_path().exists()
}

// ---- Hosts cleaning (pure) ----------------------------------------------

fn strip_managed_sections(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_managed = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == BEGIN_MARKER || trimmed == LEGACY_BEGIN {
            in_managed = true;
            continue;
        }
        if trimmed == END_MARKER || trimmed == LEGACY_END {
            in_managed = false;
            continue;
        }
        if in_managed {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Pick the source of truth for the cleaned hosts content. Prefer the
/// legacy `/etc/hosts.redd-backup` (it's the pre-modification snapshot
/// the daemon kept) when it's sane; otherwise awk-strip in place.
/// Returns the cleaned text and whether we used the legacy backup.
fn compute_cleaned_hosts() -> Result<(String, bool), String> {
    let live = std::fs::read_to_string(hosts_path()).map_err(|e| format!("read hosts: {e}"))?;
    if let Ok(legacy) = std::fs::read_to_string(legacy_hosts_backup_path()) {
        // legacy backup is "valid" if it's non-empty and contains a
        // localhost line — same gate as the helper daemon used.
        if !legacy.trim().is_empty() && legacy.contains("localhost") {
            // The legacy backup might itself contain stale markers
            // from an even-earlier era; strip them defensively.
            let cleaned = strip_managed_sections(&legacy);
            if cleaned.contains("localhost") && !cleaned.trim().is_empty() {
                return Ok((cleaned, true));
            }
        }
    }
    let cleaned = strip_managed_sections(&live);
    if !cleaned.contains("localhost") {
        return Err("refusing to write hosts without localhost".into());
    }
    Ok((cleaned, false))
}

// ---- Public commands -----------------------------------------------------

/// Legacy single-step wrapper. Kept as a Tauri command and as a public
/// fn so the `--uninstall` CLI path and the helper-shim still compile.
/// Now just calls into the bundled migration with a synthesised
/// AppHandle-less data dir.
#[tauri::command]
pub async fn strip_hosts_markers() -> Result<bool, String> {
    // No AppHandle here, so no app-data backup. Best-effort marker
    // strip via the elevated path; safe to no-op when nothing to do.
    if !migration_pending_sync() {
        return Ok(false);
    }
    let outcome = run_elevated_migration(None);
    Ok(outcome.success)
}

#[tauri::command]
pub async fn uninstall_legacy_helper() -> Result<bool, String> {
    if !migration_pending_sync() {
        return Ok(true);
    }
    let outcome = run_elevated_migration(None);
    Ok(outcome.success)
}

pub fn strip_hosts_markers_sync() -> Result<bool, String> {
    if !migration_pending_sync() {
        return Ok(false);
    }
    let outcome = run_elevated_migration(None);
    Ok(outcome.success)
}

pub fn uninstall_legacy_helper_sync() -> Result<bool, String> {
    if !migration_pending_sync() {
        return Ok(true);
    }
    let outcome = run_elevated_migration(None);
    Ok(outcome.success)
}

// ---- Onboarding orchestration --------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct OnboardingState {
    /// True if this build migrated anything in this launch
    /// (hosts cleaned, helper removed, autostart registered).
    pub migrated_this_launch: bool,
    /// True when v1.x residue (markers or legacy artefacts) is still
    /// present. Drives the "Migration incomplete" banner. False on
    /// fresh installs and after a successful migration.
    pub migration_pending: bool,
    /// True for users crossing the v1 → v2 architecture boundary in
    /// this launch. Drives the one-time "what's new" welcome card.
    pub show_upgrade_welcome: bool,
    /// True when every running-and-present browser has a compliant
    /// default profile.
    pub extension_compliant: bool,
    /// Detailed per-browser scan.
    pub browsers: crate::profile_scan::ScanResult,
}

#[derive(Debug, Clone, Copy)]
pub struct ElevatedOutcome {
    pub success: bool,
    /// True when the user cancelled the admin prompt (no destructive
    /// action attempted). Used by the frontend to soften the banner
    /// wording.
    pub user_cancelled: bool,
}

// A system-test app must never inspect or mutate the host's legacy
// hosts/daemon installation. Its data path is isolated, but the legacy
// migration operates on global system files, so make this command a
// deliberate no-op for that build.
#[cfg(feature = "system-test")]
#[tauri::command]
pub async fn run_upgrade_migration(_app: tauri::AppHandle) -> Result<bool, String> {
    Ok(true)
}

#[cfg(not(feature = "system-test"))]
#[tauri::command]
pub async fn run_upgrade_migration(app: tauri::AppHandle) -> Result<bool, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let data_path = match super::data::canonical_data_path(&app) {
        Some(p) => p,
        None => return Ok(false),
    };

    let mut data = read_data(&data_path).unwrap_or_default();

    // (A) Detect. The residue check is the authoritative gate, NOT
    // the version stamp — residue can reappear (e.g., a manual
    // reinject for testing, or a user reinstalling v1.x next to
    // 2.0). If there's nothing to clean, we no-op and stamp the
    // version. If there is residue, we run the elevated migration
    // regardless of whether we've stamped this version before.
    if !migration_pending_sync() {
        // Nothing to do — install native-host manifests on non-macOS
        // platforms and stamp the version so we don't keep checking.
        #[cfg(not(target_os = "macos"))]
        if let Err(e) = crate::native_host_install::install() {
            log::warn!("native-host install during migration failed: {e}");
        }
        stamp_version(&data_path, &mut data, &current);
        return Ok(true);
    }

    // (B+C) Run the bundled elevated migration.
    let app_data_dir = data_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);
    let outcome = run_elevated_migration(Some(&app_data_dir));

    // (D) Validate from userspace before stamping.
    if !outcome.success {
        return Ok(false);
    }
    if migration_pending_sync() {
        log::warn!("elevated migration returned ok but residue is still present");
        return Ok(false);
    }

    #[cfg(not(target_os = "macos"))]
    if let Err(e) = crate::native_host_install::install() {
        log::warn!("native-host install during migration failed: {e}");
    }

    stamp_version(&data_path, &mut data, &current);
    Ok(true)
}

#[tauri::command]
pub async fn onboarding_state(_app: tauri::AppHandle) -> Result<OnboardingState, String> {
    // PURE state report — does NOT trigger run_upgrade_migration.
    // Migration is invoked explicitly by the frontend (Continue
    // button on the pre-cleanup screen, or the retry CTA). If we
    // re-ran migration here we'd loop admin prompts every time the
    // window regains focus, since the post-cleanup screen polls this
    // command to refresh the per-browser checklist.
    let migration_pending = migration_pending_sync();
    // "We just upgraded this launch": there was residue at process
    // start, but it's now cleaned up. Persists for the lifetime of
    // the process via snapshot_initial_state.
    let show_upgrade_welcome = snapshot_initial_state() && !migration_pending;
    let migrated_this_launch = show_upgrade_welcome;

    let browsers = tauri::async_runtime::spawn_blocking(crate::profile_scan::scan_for_onboarding)
        .await
        .map_err(|e| e.to_string())?;
    let extension_compliant = crate::profile_scan::compliant(&browsers);

    Ok(OnboardingState {
        migrated_this_launch,
        migration_pending,
        show_upgrade_welcome,
        extension_compliant,
        browsers,
    })
}

// ---- Elevated execution --------------------------------------------------

/// Runs the bundled elevated migration script. `app_data_dir` is the
/// directory under which we'll keep an in-app-data snapshot of the
/// pre-edit hosts file (belt-and-braces alongside the legacy backup).
/// Returns `success=false` if any step fails — including the user
/// cancelling the admin prompt.
///
/// Public so test harnesses (`examples/test_migration.rs`) can drive
/// it without spinning up the full Tauri app + browser stack.
pub fn run_elevated_migration(app_data_dir: Option<&Path>) -> ElevatedOutcome {
    let backup_dir = app_data_dir.map(|d| d.join("backups"));
    let timestamp_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Use nanos for the status-marker path so two calls within the
    // same second can't collide (the first one's post-read delete
    // would otherwise eat the second one's marker).
    let timestamp_nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let snapshot_path = backup_dir
        .as_ref()
        .map(|d| d.join(format!("hosts.{timestamp_secs}")));

    // Compute cleaned hosts content here in Rust (we have userspace
    // read access to /etc/hosts — only writes need elevation). Any
    // failure aborts before prompting.
    let (cleaned, used_legacy) = match compute_cleaned_hosts() {
        Ok(v) => v,
        Err(e) => {
            log::warn!("migration aborted before prompt: {e}");
            return ElevatedOutcome {
                success: false,
                user_cancelled: false,
            };
        }
    };
    log::info!(
        "migration: prepared cleaned hosts content (via {})",
        if used_legacy {
            "legacy backup"
        } else {
            "in-place strip"
        }
    );

    // Best-effort: also write the snapshot ourselves from userspace.
    // /etc/hosts is world-readable on macOS, and the Windows hosts file
    // is also readable without admin. This means even if the elevated
    // script never runs (user cancels), the user already has a copy.
    if let Some(path) = &snapshot_path {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::read(hosts_path()) {
            Ok(bytes) if !bytes.is_empty() => {
                if let Err(e) = std::fs::write(path, &bytes) {
                    log::warn!("pre-flight hosts snapshot to {path:?} failed: {e}");
                }
                // Intentionally do NOT prune older snapshots. They're
                // tiny text files, migration only runs at most once
                // per version, and they're the only userspace-readable
                // recovery copy if something goes wrong post-migration.
                // Cleared during uninstall (see purge_legacy_backups_sync).
            }
            Ok(_) => log::warn!("pre-flight hosts snapshot: hosts file empty, skipping"),
            Err(e) => log::warn!("pre-flight hosts snapshot read failed: {e}"),
        }
    }

    // Stage cleaned content to a temp file readable by the elevated
    // process. mktemp-style: in tempdir with a unique name.
    let staged = match stage_cleaned_content(&cleaned) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("migration aborted: failed to stage cleaned hosts: {e}");
            return ElevatedOutcome {
                success: false,
                user_cancelled: false,
            };
        }
    };

    let status_path = std::env::temp_dir().join(format!("redd-migration-status.{timestamp_nanos}"));
    // Best-effort cleanup of any stale prior status file.
    let _ = std::fs::remove_file(&status_path);
    log::info!(
        "migration: status marker target = {}",
        status_path.display()
    );

    #[cfg(target_os = "macos")]
    let outcome = run_elevated_macos(&staged, &status_path);
    #[cfg(target_os = "windows")]
    let outcome = run_elevated_windows(&staged, &status_path);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let outcome = ElevatedOutcome {
        success: true,
        user_cancelled: false,
    };

    let _ = std::fs::remove_file(&staged);

    // Final gate: the elevated script writes STATUS_OK only after
    // every ordered step succeeded. If the marker is missing, treat
    // this as a failure even if the process returned 0 for some
    // reason (e.g. PowerShell -Verb RunAs returning prematurely).
    let marker_read = std::fs::read_to_string(&status_path);
    let marker_ok = match &marker_read {
        Ok(s) => s.trim() == STATUS_OK,
        Err(_) => false,
    };
    if !marker_ok {
        match marker_read {
            Ok(s) => log::warn!("migration: status marker present but wrong content: {:?}", s),
            Err(e) => log::warn!(
                "migration: could not read status marker at {}: {} (osascript said success={}, user_cancelled={})",
                status_path.display(),
                e,
                outcome.success,
                outcome.user_cancelled
            ),
        }
    }
    let _ = std::fs::remove_file(&status_path);
    if !marker_ok {
        return ElevatedOutcome {
            success: false,
            ..outcome
        };
    }

    outcome
}

fn stage_cleaned_content(content: &str) -> std::io::Result<PathBuf> {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("redd-hosts-cleaned.{timestamp}"));
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Best-effort cleanup of every backup the migration ever created.
/// Called from the `--uninstall` CLI path; never from the migration
/// flow itself (we want backups to outlive normal operation in case
/// something goes wrong in a future release).
///
/// Reachable in practice ONLY from the Windows NSIS pre-uninstall
/// hook. macOS has no `--uninstall` invocation path — users drag the
/// app to Trash, which never runs our binary — so on macOS both
/// backup paths persist indefinitely. That's intentional: the legacy
/// `/etc/hosts.redd-backup` requires root anyway and is genuinely the
/// user's last-resort recovery copy of their pre-modification hosts
/// file. The in-app-data snapshots are tiny and unobtrusive.
///
/// On Windows the NSIS uninstaller runs elevated, so an unprivileged
/// delete of the legacy backup succeeds from this code path.
pub fn purge_legacy_backups_sync(app_data_dir: Option<&Path>) {
    let _ = std::fs::remove_file(legacy_hosts_backup_path());
    if let Some(dir) = app_data_dir {
        let _ = std::fs::remove_dir_all(dir.join("backups"));
    }
}

#[cfg(target_os = "macos")]
fn run_elevated_macos(staged: &Path, status_path: &Path) -> ElevatedOutcome {
    use std::process::Command;

    // Build the shell script. set -e so any failed gate aborts before
    // anything destructive runs. We touch the daemon ONLY after the
    // hosts atomic-rename succeeds, and the legacy /etc/hosts.redd-backup
    // ONLY after the daemon is gone.
    //
    // The shell script writes STATUS_OK to the status file only if it
    // reaches the end with no failure. Rust reads that marker after
    // the process exits.
    let staged_str = staged.display().to_string();
    let status_str = status_path.display().to_string();

    // Shell escape: the paths contain only timestamp / temp-dir
    // characters, so single-quoting is safe. Reject anything weird
    // up front to be defensive.
    if staged_str.contains('\'') || status_str.contains('\'') {
        log::warn!("migration aborted: unexpected quote in staged paths");
        return ElevatedOutcome {
            success: false,
            user_cancelled: false,
        };
    }

    // Script body lives in a sibling .sh file so it can be edited
    // with shell syntax highlighting, linted with shellcheck, and
    // tested in isolation. Two placeholders are substituted at
    // runtime; STATUS_OK is hard-coded in the script (must stay in
    // sync with the Rust constant — both equal "ok").
    const SCRIPT_TEMPLATE: &str = include_str!("migration/cleanup.sh");
    debug_assert_eq!(STATUS_OK, "ok", "cleanup.sh hard-codes 'ok'");
    let inner = SCRIPT_TEMPLATE
        .replace("{STAGED}", &staged_str)
        .replace("{STATUS}", &status_str);

    // Wrap in osascript do shell script. Single admin prompt for the
    // user. The prompt wording mentions both pieces of work so the
    // user knows what they're approving.
    let escaped = inner.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"do shell script "{}" with administrator privileges with prompt "Digital Habits: Blocker needs to clean up the old hosts-file entries and remove the legacy helper.""#,
        escaped
    );

    match Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
    {
        Ok(out) => {
            if out.status.success() {
                ElevatedOutcome {
                    success: true,
                    user_cancelled: false,
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr);
                // osascript returns -128 / "User cancelled" when the
                // user clicks Cancel on the admin prompt.
                let cancelled = stderr.contains("User cancelled") || stderr.contains("-128");
                if !cancelled {
                    log::warn!("elevated migration script failed: {}", stderr.trim());
                }
                ElevatedOutcome {
                    success: false,
                    user_cancelled: cancelled,
                }
            }
        }
        Err(e) => {
            log::warn!("failed to launch osascript: {e}");
            ElevatedOutcome {
                success: false,
                user_cancelled: false,
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn run_elevated_windows(staged: &Path, status_path: &Path) -> ElevatedOutcome {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // CREATE_NO_WINDOW: keep the outer (non-elevated) launcher invisible.
    // The inner elevated PowerShell is hidden separately via -WindowStyle.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let staged_str = staged.display().to_string();
    let status_str = status_path.display().to_string();

    // PowerShell with $ErrorActionPreference='Stop' so any failure
    // aborts the script before destructive steps. Single UAC prompt
    // via `Start-Process -Verb RunAs`.
    //
    // The outer call writes the inner script to a temp file (so we
    // don't have to deal with double-quote escaping through two
    // PowerShell invocations) and runs it elevated, waiting for it
    // to exit so we can read the status marker.
    // Same pattern as macOS: script body in a sibling .ps1 file so
    // it can be edited with PowerShell syntax highlighting, linted
    // with PSScriptAnalyzer, and tested in isolation. Two
    // placeholders substituted at runtime.
    const SCRIPT_TEMPLATE: &str = include_str!("migration/cleanup.ps1");
    debug_assert_eq!(STATUS_OK, "ok", "cleanup.ps1 hard-codes 'ok'");
    let inner_script = SCRIPT_TEMPLATE
        .replace("{STAGED}", &staged_str.replace('\'', "''"))
        .replace("{STATUS}", &status_str.replace('\'', "''"));

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let inner_path = std::env::temp_dir().join(format!("redd-migration.{timestamp}.ps1"));
    if let Err(e) = std::fs::write(&inner_path, inner_script) {
        log::warn!("failed to stage windows migration script: {e}");
        return ElevatedOutcome {
            success: false,
            user_cancelled: false,
        };
    }

    // Outer launcher: spawn elevated PowerShell to run the inner
    // script and wait. Capture exit code; UAC cancellation surfaces
    // as a launch error from Start-Process -Verb RunAs.
    let launcher = format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy','Bypass',
    '-WindowStyle','Hidden', '-File','{inner}'
  ) -Verb RunAs -WindowStyle Hidden -PassThru -Wait
  exit $p.ExitCode
}} catch {{
  # User cancelled UAC, or other launch failure.
  exit 1223
}}
"#,
        inner = inner_path.display().to_string().replace('\'', "''"),
    );

    let outcome = match Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launcher,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => {
            // Windows uses exit code 1223 (ERROR_CANCELLED) for "user
            // declined elevation". We synthesise the same code for
            // the catch branch above.
            let code = out.status.code().unwrap_or(-1);
            let cancelled = code == 1223;
            let success = code == 0;
            if !success && !cancelled {
                log::warn!(
                    "elevated migration powershell failed: code={} stderr={}",
                    code,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            ElevatedOutcome {
                success,
                user_cancelled: cancelled,
            }
        }
        Err(e) => {
            log::warn!("failed to launch powershell: {e}");
            ElevatedOutcome {
                success: false,
                user_cancelled: false,
            }
        }
    };

    let _ = std::fs::remove_file(&inner_path);
    outcome
}

// ---- Settings persistence -----------------------------------------------

fn stamp_version(
    data_path: &Path,
    data: &mut serde_json::Map<String, serde_json::Value>,
    current: &str,
) {
    let settings = data
        .entry("settings".to_string())
        .or_insert(serde_json::Value::Object(Default::default()));
    if let Some(obj) = settings.as_object_mut() {
        obj.insert(
            "migrationRanAtVersion".to_string(),
            serde_json::Value::String(current.to_string()),
        );
        obj.insert(
            "migrationRanAt".to_string(),
            serde_json::Value::Number(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
                    .into(),
            ),
        );
    }
    if let Err(e) = write_data(data_path, data) {
        log::warn!(
            "failed to persist migrationRanAtVersion at {:?}: {}",
            data_path,
            e
        );
    }
}

fn read_data(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed.as_object().cloned()
}

fn write_data(
    path: &Path,
    data: &serde_json::Map<String, serde_json::Value>,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(&serde_json::Value::Object(data.clone()))?;
    std::fs::write(path, body)
}

#[cfg(test)]
mod tests;
