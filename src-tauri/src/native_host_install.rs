// Install the native-messaging manifest(s) so the browser knows to
// spawn this binary when the extension calls `connectNative`.
//
// - macOS / Linux: write a JSON manifest into each browser's
//   NativeMessagingHosts directory. All user-scope; no admin needed.
// - Windows: write a JSON manifest to a user-scoped directory and
//   register its path in `HKCU\Software\<Vendor>\<Browser>\NativeMessagingHosts\<name>`.
//
// Safari is not covered here — Safari routes native messaging
// directly to `SafariWebExtensionHandler.swift` inside the signed app
// bundle; there is no manifest file.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::json;

pub const HOST_NAME: &str = "com.ulriklyngs.mindshield";
pub const FIREFOX_EXT_ID: &str = "mindshield@example.com";
pub const CHROMIUM_EXT_ID: &str = "hhblkhfdjijdinijakbmcpkmdfhoadcd";
/// Microsoft Edge Add-ons listing ID — differs from the Chrome Web
/// Store ID when the user installs manually from edge://extensions.
pub const EDGE_ADDONS_EXT_ID: &str = "gmjfgjdhnhcegfelcddbdljdffiaepam";
/// Bundle identifier of the legacy bundled Safari Web Extension (no longer
/// shipped). Still referenced for duplicate-extension detection when a
/// user has both the App Store ReDD Focus and an old embedded copy.
pub const SAFARI_EXT_ID: &str = "com.reddblock.SafariExtension";

/// Every Chromium-family extension ID ReDD Blocker treats as ReDD Focus.
/// Includes both the Chrome Web Store ID (auto-install hint) and the
/// Edge Add-ons ID (manual install from Microsoft's store).
pub fn chromium_extension_ids() -> Vec<String> {
    let mut ids = vec![CHROMIUM_EXT_ID.to_string(), EDGE_ADDONS_EXT_ID.to_string()];
    if cfg!(debug_assertions) {
        if let Ok(extra) = std::env::var("REDD_DEV_EXT_ID") {
            for id in extra.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

#[derive(Debug, Clone, Copy, Serialize)]
pub enum BrowserTarget {
    Chrome,
    Brave,
    Edge,
    Firefox,
}

impl BrowserTarget {
    #[allow(dead_code)] // iterated by the non-macOS install path
    fn all() -> [BrowserTarget; 4] {
        [
            BrowserTarget::Chrome,
            BrowserTarget::Brave,
            BrowserTarget::Edge,
            BrowserTarget::Firefox,
        ]
    }

    /// Directory where the browser expects to find native-messaging
    /// host manifests. User-scope only.
    #[cfg_attr(target_os = "windows", allow(unused_variables))] // `home` is macOS/Linux only
    fn manifest_dir(self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        #[cfg(target_os = "macos")]
        {
            let p = match self {
                BrowserTarget::Chrome => {
                    "Library/Application Support/Google/Chrome/NativeMessagingHosts"
                }
                BrowserTarget::Brave => {
                    "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
                }
                BrowserTarget::Edge => {
                    "Library/Application Support/Microsoft Edge/NativeMessagingHosts"
                }
                BrowserTarget::Firefox => {
                    "Library/Application Support/Mozilla/NativeMessagingHosts"
                }
            };
            Some(home.join(p))
        }
        #[cfg(target_os = "windows")]
        {
            // Windows doesn't use a per-browser directory; the manifest
            // lives wherever we want and is referenced by registry key.
            let _ = self;
            Some(crate::product_identity::windows_primary_local_product_dir()?.join("native-host"))
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            let p = match self {
                BrowserTarget::Chrome => ".config/google-chrome/NativeMessagingHosts",
                BrowserTarget::Brave => ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
                BrowserTarget::Edge => ".config/microsoft-edge/NativeMessagingHosts",
                BrowserTarget::Firefox => ".mozilla/native-messaging-hosts",
            };
            Some(home.join(p))
        }
    }
}

/// Build the JSON manifest body for a given browser. Chromium and
/// Firefox have slightly different schemas:
///   - Chromium uses `allowed_origins` with chrome-extension://<id>/
///   - Firefox uses `allowed_extensions` with <addon@id>
///
/// In debug builds, comma-separated IDs from `REDD_DEV_EXT_ID` are
/// appended to `allowed_origins` so an unpacked dev extension can
/// connect alongside the production-store one. The env var is ignored
/// in release builds so production users only ever trust the store ID.
fn manifest_body(browser: BrowserTarget, binary_path: &str) -> serde_json::Value {
    let mut obj = json!({
        "name": HOST_NAME,
        "description": "Digital Habits Blocker native messaging host",
        "path": binary_path,
        "type": "stdio",
    });
    match browser {
        BrowserTarget::Firefox => {
            obj["allowed_extensions"] = json!([FIREFOX_EXT_ID]);
        }
        _ => {
            let origins: Vec<String> = chromium_extension_ids()
                .into_iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect();
            obj["allowed_origins"] = json!(origins);
        }
    }
    obj
}

/// Path the native-messaging manifest will reference. We want the
/// currently-running Tauri binary so that spawning it with the
/// `--native-host` argument enters the stdio loop.
pub fn current_binary_path() -> Option<String> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.to_str().map(String::from))
}

/// Microsoft Store (MSIX) installs live under `WindowsApps`, which
/// browsers cannot spawn as a native-messaging host.
#[cfg(target_os = "windows")]
pub fn is_msix_packaged_exe_path(path: &std::path::Path) -> bool {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .contains("windowsapps")
}

#[cfg(not(target_os = "windows"))]
pub fn is_msix_packaged_exe_path(_path: &std::path::Path) -> bool {
    false
}

/// Path the native-messaging manifest should reference right now.
/// Does not copy files — safe to call from hot paths like profile scan.
#[cfg(target_os = "windows")]
fn host_binary_path_for_manifest() -> std::io::Result<String> {
    let source = std::env::current_exe().map_err(|e| std::io::Error::other(e.to_string()))?;
    if is_msix_packaged_exe_path(&source) {
        let dest_dir = native_host_stage_dir()
            .ok_or_else(|| std::io::Error::other("cannot resolve LOCALAPPDATA"))?;
        let dest_exe = dest_dir.join(STAGED_NATIVE_HOST_EXE);
        if dest_exe.exists() {
            if staged_copy_stale(&source, &dest_exe) {
                ensure_staged_native_host(&source)?;
            }
            return dest_exe
                .to_str()
                .map(String::from)
                .ok_or_else(|| std::io::Error::other("non-utf8 staged path"));
        }
        return ensure_staged_native_host(&source);
    }
    source
        .to_str()
        .map(String::from)
        .ok_or_else(|| std::io::Error::other("non-utf8 exe path"))
}

#[cfg(not(target_os = "windows"))]
fn host_binary_path_for_manifest() -> std::io::Result<String> {
    std::env::current_exe()
        .map_err(|e| std::io::Error::other(e.to_string()))?
        .to_str()
        .map(String::from)
        .ok_or_else(|| std::io::Error::other("non-utf8 exe path"))
}

/// Path written into native-messaging manifests. MSIX builds stage a
/// full copy of the install dir under `%LOCALAPPDATA%` (exe + DLLs).
fn manifest_binary_path() -> std::io::Result<String> {
    #[cfg(target_os = "windows")]
    {
        let source = std::env::current_exe().map_err(|e| std::io::Error::other(e.to_string()))?;
        if is_msix_packaged_exe_path(&source) {
            return ensure_staged_native_host(&source);
        }
    }
    host_binary_path_for_manifest()
}

#[cfg(target_os = "windows")]
fn staged_copy_stale(source_exe: &std::path::Path, dest_exe: &std::path::Path) -> bool {
    match (source_exe.metadata(), dest_exe.metadata()) {
        (Ok(src_meta), Ok(dest_meta)) => {
            src_meta.len() != dest_meta.len()
                || src_meta.modified().ok() > dest_meta.modified().ok()
        }
        _ => true,
    }
}

#[cfg(target_os = "windows")]
const STAGED_NATIVE_HOST_EXE: &str = "redd-block.exe";

#[cfg(target_os = "windows")]
fn native_host_stage_dir() -> Option<PathBuf> {
    Some(crate::product_identity::windows_primary_local_product_dir()?.join("native-host"))
}

/// Staged copy used for native messaging (and Store uninstall cleanup).
#[cfg(target_os = "windows")]
pub fn staged_native_host_exe() -> Option<PathBuf> {
    let path = native_host_stage_dir()?.join(STAGED_NATIVE_HOST_EXE);
    path.exists().then_some(path)
}

#[cfg(target_os = "windows")]
fn copy_if_newer(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    let needs_copy = match (src.metadata(), dest.metadata()) {
        (Ok(src_meta), Ok(dest_meta)) => {
            src_meta.len() != dest_meta.len()
                || src_meta.modified().ok() > dest_meta.modified().ok()
        }
        _ => true,
    };
    if needs_copy {
        std::fs::copy(src, dest)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            copy_if_newer(&entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_install_dir_to_stage(
    source_dir: &std::path::Path,
    dest_dir: &std::path::Path,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dest_dir)?;
    let mut copied = 0usize;
    for entry in std::fs::read_dir(source_dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let dest = dest_dir.join(entry.file_name());
        if ft.is_dir() {
            if dest.exists() {
                let _ = std::fs::remove_dir_all(&dest);
            }
            copy_dir_recursive(&entry.path(), &dest)?;
            copied += 1;
        } else if ft.is_file() {
            copy_if_newer(&entry.path(), &dest)?;
            copied += 1;
        }
    }
    log::info!(
        "native-host: staged {copied} item(s) from {} -> {}",
        source_dir.display(),
        dest_dir.display()
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn ensure_staged_native_host(source_exe: &std::path::Path) -> std::io::Result<String> {
    let source_dir = source_exe
        .parent()
        .ok_or_else(|| std::io::Error::other("exe has no parent dir"))?;
    let dest_dir = native_host_stage_dir()
        .ok_or_else(|| std::io::Error::other("cannot resolve LOCALAPPDATA"))?;
    sync_install_dir_to_stage(source_dir, &dest_dir)?;
    let dest_exe = dest_dir.join(STAGED_NATIVE_HOST_EXE);
    if !dest_exe.exists() {
        return Err(std::io::Error::other(format!(
            "staged exe missing at {}",
            dest_exe.display()
        )));
    }
    dest_exe
        .to_str()
        .map(String::from)
        .ok_or_else(|| std::io::Error::other("non-utf8 staged path"))
}

#[cfg(target_os = "windows")]
fn remove_staged_native_host() {
    if let Some(dir) = native_host_stage_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
    // Prior product-folder staging dirs from rebrands.
    for legacy in crate::product_identity::windows_legacy_local_product_dirs() {
        let _ = std::fs::remove_dir_all(legacy.join("native-host"));
    }
}

#[cfg(target_os = "windows")]
fn windows_manifest_path(browser: BrowserTarget) -> Option<PathBuf> {
    let dir = browser.manifest_dir()?;
    Some(dir.join(format!("{HOST_NAME}-{}.json", browser_slug(browser))))
}

/// `true` when the manifest file, HKCU registry entry, host binary,
/// and manifest body (path, allowed origins, etc.) are all present and
/// consistent. Chrome discovers hosts via registry only — a manifest
/// file on disk without the key yields "host not found".
#[cfg(target_os = "windows")]
pub fn native_host_is_current(browser: BrowserTarget) -> bool {
    let Ok(expected) = host_binary_path_for_manifest() else {
        return false;
    };
    if !std::path::Path::new(&expected).exists() {
        return false;
    }
    let Some(manifest_path) = windows_manifest_path(browser) else {
        return false;
    };
    if !windows_registry_points_at_manifest(browser, &manifest_path) {
        return false;
    }
    let Ok(manifest_binary) = manifest_binary_path() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return false;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    val == manifest_body(browser, &manifest_binary)
}

#[cfg(target_os = "windows")]
fn windows_registry_points_at_manifest(
    browser: BrowserTarget,
    manifest_path: &std::path::Path,
) -> bool {
    let Some(registered) = read_hkcu_default(&registry_key_path(browser)) else {
        return false;
    };
    std::path::Path::new(&registered) == manifest_path
}

#[cfg(not(target_os = "windows"))]
pub fn native_host_is_current(_browser: BrowserTarget) -> bool {
    false
}

/// Install the native-messaging manifest for every supported browser.
///
/// Marker-gated: if our own bookkeeping file says we already wrote
/// manifests for the current binary path, skip the cross-app writes
/// entirely. Each call to `install_one` does
/// `create_dir_all` + `write` inside another app's data dir, which on
/// macOS Sonoma+ fires the "ReDD Blocker would like to access data from
/// other apps" TCC prompt — even when the write would be a no-op.
/// Doing this on every launch was the dominant source of repeated
/// prompts during build → install iteration.
///
/// The marker lives at
/// `~/Library/Application Support/com.reddblock/native-host-install.v1`
/// (our own data dir — no cross-app touch to check or write it). It
/// stores the absolute binary path we last wrote manifests for. Any
/// change to the path (.app moved, .pkg installed somewhere else,
/// `tauri dev` vs installed) invalidates the marker and triggers a
/// fresh write pass. The schema-version suffix in the filename
/// (`v1`) lets us re-run for everyone if we ever change the manifest
/// format itself: bump to `v2`.
///
/// For an explicit "reinstall manifests now" affordance (e.g. user
/// hits a Reinstall hints button in the UI), use [`install_force`].
// On macOS this function is an early return by design (Firefox setup is
// manual there); the rest of the body is the Windows/Linux path.
#[cfg_attr(target_os = "macos", allow(unreachable_code))]
pub fn install() -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        log::info!("native_host_install::install() skipped on macOS — Firefox setup is manual");
        return Ok(());
    }

    let binary =
        current_binary_path().ok_or_else(|| std::io::Error::other("cannot resolve current exe"))?;

    log::info!("tcc-probe: native_host_install::install() entered, binary={binary}");

    if startup_install_already_done_for(&binary) {
        #[cfg(target_os = "windows")]
        {
            if let Ok(source) = std::env::current_exe() {
                if is_msix_packaged_exe_path(&source) {
                    if let Err(e) = ensure_staged_native_host(&source) {
                        log::warn!("native-host: MSIX stage refresh failed: {e}");
                    }
                }
            }
            let stale = install_targets()
                .iter()
                .any(|b| !native_host_is_current(*b));
            if stale {
                log::info!("native-host: repairing stale manifests or missing registry keys");
                let manifest_binary = manifest_binary_path()?;
                install_inner(&manifest_binary);
                mark_startup_install_done_for(&binary);
                return Ok(());
            }
        }
        log::info!(
            "tcc-probe: native_host_install::install() marker matches binary path, skipping (no cross-app touches)"
        );
        return Ok(());
    }

    let manifest_binary = manifest_binary_path()?;
    install_inner(&manifest_binary);
    mark_startup_install_done_for(&binary);
    log::info!(
        "tcc-probe: native_host_install::install() exited (wrote manifests + dropped marker)"
    );
    Ok(())
}

/// Install the native-messaging manifest for one browser. Used when the
/// user opts into extension mode on macOS Chromium.
pub fn install_native_host_for(browser: BrowserTarget) -> std::io::Result<()> {
    let binary = manifest_binary_path()?;
    install_one(browser, &binary)
}

/// `true` when the browser's manifest is missing or differs from the
/// manifest we would write right now (binary path, allowed origins, etc).
pub fn manifest_needs_update(browser: BrowserTarget, binary: &str) -> bool {
    let Some(dir) = browser.manifest_dir() else {
        return true;
    };
    let path = dir.join(format!("{HOST_NAME}.json"));
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return true;
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    val != manifest_body(browser, binary)
}

/// On macOS, ensure every Chromium browser set to extension mode has an
/// up-to-date native-messaging manifest. Skips browsers already pointing
/// at the current binary so startup does not re-touch other apps' data
/// dirs (and re-trigger TCC) on every launch.
#[cfg(target_os = "macos")]
pub fn sync_extension_mode_native_hosts(
    path: &std::path::Path,
    force: bool,
) -> std::io::Result<()> {
    use crate::blocking_method::{self, Method, MAC_CHROMIUM_KEYS};

    let binary =
        current_binary_path().ok_or_else(|| std::io::Error::other("cannot resolve current exe"))?;

    for key in MAC_CHROMIUM_KEYS {
        if blocking_method::method_for_key_at_path(path, key) != Method::Extension {
            continue;
        }
        let Some(target) = blocking_method::native_host_target(key) else {
            continue;
        };
        if !force && !manifest_needs_update(target, &binary) {
            log::debug!("native-host sync: {key} manifest already current, skipping");
            continue;
        }
        log::info!("native-host sync: writing manifest for {key}");
        if let Err(e) = install_one(target, &binary) {
            log::warn!("native-host sync for {key} failed: {e}");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn sync_extension_mode_native_hosts(
    _path: &std::path::Path,
    _force: bool,
) -> std::io::Result<()> {
    Ok(())
}

/// macOS Firefox: write the native-messaging manifest when missing or stale.
/// No-op when Firefox is not installed. Skips the write when already current
/// unless `force` is true (explicit user refresh).
#[cfg(target_os = "macos")]
pub fn sync_firefox_native_host(force: bool) -> std::io::Result<()> {
    if !crate::profile_scan::firefox_app_installed() {
        return Ok(());
    }
    let binary =
        current_binary_path().ok_or_else(|| std::io::Error::other("cannot resolve current exe"))?;
    if !force && !manifest_needs_update(BrowserTarget::Firefox, &binary) {
        log::debug!("native-host sync: firefox manifest already current, skipping");
        return Ok(());
    }
    log::info!("native-host sync: writing manifest for firefox");
    install_one(BrowserTarget::Firefox, &binary)
}

#[cfg(not(target_os = "macos"))]
pub fn sync_firefox_native_host(_force: bool) -> std::io::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn firefox_native_host_is_current() -> bool {
    let Some(binary) = current_binary_path() else {
        return false;
    };
    !manifest_needs_update(BrowserTarget::Firefox, &binary)
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::needless_return)] // cfg dispatch: the return is load-bearing on the other platform
pub fn firefox_native_host_is_current() -> bool {
    #[cfg(target_os = "windows")]
    {
        return native_host_is_current(BrowserTarget::Firefox);
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

/// Remove the native-messaging manifest for one browser.
pub fn uninstall_native_host_for(browser: BrowserTarget) -> std::io::Result<()> {
    uninstall_one(browser)
}

/// Force-write the native-messaging manifest for every supported
/// browser, ignoring the marker. Use for the user-driven "Reinstall
/// hints" command — they're explicitly asking us to refresh, so the
/// TCC prompt is contextually expected. Drops the marker on success
/// so the next startup call stays silent.
// On macOS this function is an early return by design (Firefox setup is
// manual there); the rest of the body is the Windows/Linux path.
#[cfg_attr(target_os = "macos", allow(unreachable_code))]
pub fn install_force() -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        log::info!(
            "native_host_install::install_force() skipped on macOS — Firefox setup is manual"
        );
        return Ok(());
    }

    let binary =
        current_binary_path().ok_or_else(|| std::io::Error::other("cannot resolve current exe"))?;
    log::info!("tcc-probe: native_host_install::install_force() entered, binary={binary}");
    let manifest_binary = manifest_binary_path()?;
    install_inner(&manifest_binary);
    mark_startup_install_done_for(&binary);
    log::info!("tcc-probe: native_host_install::install_force() exited");
    Ok(())
}

fn install_inner(binary: &str) {
    for browser in install_targets() {
        log::info!("tcc-probe: native_host_install::install_one({browser:?}) start");
        if let Err(e) = install_one(browser, binary) {
            // Don't fail the whole operation for a single browser
            // (e.g. Firefox not installed). Log and continue.
            log::warn!("native-host install for {browser:?} failed: {e}");
        }
        log::info!("tcc-probe: native_host_install::install_one({browser:?}) done");
    }
}

/// Browsers that receive a native-messaging manifest on this platform.
fn install_targets() -> Vec<BrowserTarget> {
    #[cfg(target_os = "macos")]
    {
        vec![BrowserTarget::Firefox]
    }
    #[cfg(not(target_os = "macos"))]
    {
        BrowserTarget::all().to_vec()
    }
}

/// Remove the manifest for every supported browser. Safe to call even
/// if install never ran. Also clears the install marker so the next
/// `install()` call definitely re-writes (uninstall is rare and the
/// re-write cost on the next install is acceptable).
pub fn uninstall() -> std::io::Result<()> {
    for browser in install_targets() {
        if let Err(e) = uninstall_one(browser) {
            log::warn!("native-host uninstall for {browser:?} failed: {e}");
        }
    }
    #[cfg(target_os = "windows")]
    remove_staged_native_host();
    clear_startup_install_marker();
    Ok(())
}

// ---- Marker bookkeeping ---------------------------------------------------

/// Absolute path of the per-machine "we already wrote manifests for
/// this binary path" marker. Lives in our own app-data dir so the
/// stat/read/write to maintain it never touches another app's
/// territory. Returns `None` when `dirs::data_local_dir` can't
/// resolve (extremely rare; would imply a broken `$HOME`).
fn startup_install_marker_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    Some(base.join("com.reddblock").join("native-host-install.v1"))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StartupInstallMarker {
    binary_path: String,
}

/// `true` when the marker exists AND records the same binary path
/// we're about to write for. Any mismatch — missing marker, parse
/// failure, different binary path — returns `false` so we re-run the
/// install. The asymmetric "default to re-run on any uncertainty"
/// is deliberate: the failure mode for a needless re-run is at most
/// one extra TCC prompt, but the failure mode for a wrongly-skipped
/// install is broken native messaging until the user notices.
fn startup_install_already_done_for(binary: &str) -> bool {
    let Some(path) = startup_install_marker_path() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(marker) = serde_json::from_str::<StartupInstallMarker>(&raw) else {
        return false;
    };
    marker.binary_path == binary
}

fn mark_startup_install_done_for(binary: &str) {
    let Some(path) = startup_install_marker_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = StartupInstallMarker {
        binary_path: binary.to_string(),
    };
    let Ok(bytes) = serde_json::to_vec(&payload) else {
        return;
    };
    let _ = std::fs::write(&path, bytes);
}

fn clear_startup_install_marker() {
    let Some(path) = startup_install_marker_path() else {
        return;
    };
    let _ = std::fs::remove_file(&path);
}

#[cfg(not(target_os = "windows"))]
fn install_one(browser: BrowserTarget, binary: &str) -> std::io::Result<()> {
    let dir = browser
        .manifest_dir()
        .ok_or_else(|| std::io::Error::other("cannot resolve manifest dir"))?;
    log::info!(
        "tcc-probe: about to create_dir_all (cross-app) {} [browser={browser:?}]",
        dir.display()
    );
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{HOST_NAME}.json"));
    let body = manifest_body(browser, binary);
    log::info!(
        "tcc-probe: about to write (cross-app) {} [browser={browser:?}]",
        path.display()
    );
    std::fs::write(path, serde_json::to_vec_pretty(&body)?)?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn uninstall_one(browser: BrowserTarget) -> std::io::Result<()> {
    let dir = browser
        .manifest_dir()
        .ok_or_else(|| std::io::Error::other("cannot resolve manifest dir"))?;
    let path = dir.join(format!("{HOST_NAME}.json"));
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    // Remove the dir only if we created it and it's now empty.
    if let Ok(mut rd) = std::fs::read_dir(&dir) {
        if rd.next().is_none() {
            let _ = std::fs::remove_dir(&dir);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_one(browser: BrowserTarget, binary: &str) -> std::io::Result<()> {
    // 1. Write the manifest to %LOCALAPPDATA%\Digital Habits Blocker\native-host\.
    let dir = browser
        .manifest_dir()
        .ok_or_else(|| std::io::Error::other("cannot resolve manifest dir"))?;
    std::fs::create_dir_all(&dir)?;
    let manifest_path = dir.join(format!("{HOST_NAME}-{}.json", browser_slug(browser)));
    let body = manifest_body(browser, binary);
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&body)?)?;

    // 2. Register the manifest path in HKCU.
    let registry_key = registry_key_path(browser);
    let manifest_str = manifest_path
        .to_str()
        .ok_or_else(|| std::io::Error::other("non-utf8 manifest path"))?;
    write_hkcu_default(&registry_key, manifest_str)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn uninstall_one(browser: BrowserTarget) -> std::io::Result<()> {
    // Remove registry key + manifest file.
    let _ = delete_hkcu_key(&registry_key_path(browser));
    if let Some(dir) = browser.manifest_dir() {
        let manifest_path = dir.join(format!("{HOST_NAME}-{}.json", browser_slug(browser)));
        if manifest_path.exists() {
            let _ = std::fs::remove_file(&manifest_path);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn browser_slug(browser: BrowserTarget) -> &'static str {
    match browser {
        BrowserTarget::Chrome => "chrome",
        BrowserTarget::Brave => "brave",
        BrowserTarget::Edge => "edge",
        BrowserTarget::Firefox => "firefox",
    }
}

#[cfg(target_os = "windows")]
fn registry_key_path(browser: BrowserTarget) -> String {
    // All HKCU — no UAC. Chrome/Brave/Edge use the same schema under
    // their vendor key; Firefox uses Mozilla\NativeMessagingHosts.
    match browser {
        BrowserTarget::Chrome => {
            format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}")
        }
        BrowserTarget::Brave => {
            format!(r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{HOST_NAME}")
        }
        BrowserTarget::Edge => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}"),
        BrowserTarget::Firefox => format!(r"Software\Mozilla\NativeMessagingHosts\{HOST_NAME}"),
    }
}

#[cfg(target_os = "windows")]
fn read_hkcu_default(path: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        REG_VALUE_TYPE,
    };

    unsafe {
        let mut hkey: HKEY = HKEY::default();
        let subkey = to_wide(path);
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            KEY_READ,
            &mut hkey,
        );
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut reg_type = REG_VALUE_TYPE::default();
        let mut buf_size: u32 = 0;
        let _ = RegQueryValueExW(
            hkey,
            PCWSTR::null(),
            None,
            Some(&mut reg_type),
            None,
            Some(&mut buf_size),
        );
        if buf_size == 0 {
            let _ = RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u8; buf_size as usize];
        let status = RegQueryValueExW(
            hkey,
            PCWSTR::null(),
            None,
            Some(&mut reg_type),
            Some(buf.as_mut_ptr()),
            Some(&mut buf_size),
        );
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS || reg_type != REG_SZ {
            return None;
        }
        let wide_len = (buf_size as usize / 2).saturating_sub(1);
        let wide = std::slice::from_raw_parts(buf.as_ptr() as *const u16, wide_len);
        String::from_utf16(wide).ok()
    }
}

#[cfg(target_os = "windows")]
fn write_hkcu_default(path: &str, value: &str) -> std::io::Result<()> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    unsafe {
        let mut hkey: HKEY = HKEY::default();
        let subkey = to_wide(path);
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        );
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::other(format!(
                "RegCreateKeyExW failed: {status:?}"
            )));
        }
        let data_wide = to_wide(value);
        let bytes_len = (data_wide.len() * 2) as u32;
        let data_bytes =
            std::slice::from_raw_parts(data_wide.as_ptr() as *const u8, bytes_len as usize);
        let _ = w!("");
        let status = RegSetValueExW(hkey, PCWSTR::null(), Some(0), REG_SZ, Some(data_bytes));
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::other(format!(
                "RegSetValueExW failed: {status:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn delete_hkcu_key(path: &str) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};

    unsafe {
        let wide = to_wide(path);
        let status = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr()));
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::other(format!(
                "RegDeleteKeyW failed: {status:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Tauri command wrappers.
///
/// `install_native_host` is the explicit "Reinstall hints" affordance,
/// so it bypasses the startup-install marker — the user clicked a
/// button asking us to refresh, and they'll accept the TCC prompt
/// (or have already granted it) as part of that action. The startup
/// auto-install path in `lib.rs::run` uses [`install`] (marker-gated)
/// instead.
#[tauri::command]
pub fn install_native_host(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = crate::commands::canonical_data_path(&app)
            .ok_or_else(|| "no app data path".to_string())?;
        sync_extension_mode_native_hosts(&path, true).map_err(|e| e.to_string())?;
        sync_firefox_native_host(true).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        install_force().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn ensure_firefox_native_host() -> Result<(), String> {
    sync_firefox_native_host(true).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn uninstall_native_host() -> Result<(), String> {
    uninstall().map_err(|e| e.to_string())
}
