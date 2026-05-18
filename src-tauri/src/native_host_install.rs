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
/// Bundle identifier of the Safari Web Extension target embedded
/// inside `ReDD Block.app/Contents/PlugIns/`. Set by
/// `scripts/build-safari-extension.sh` via the
/// `PRODUCT_BUNDLE_IDENTIFIER` xcodebuild override — keep these in
/// sync.
pub const SAFARI_EXT_ID: &str = "com.reddblock.SafariExtension";

#[derive(Debug, Clone, Copy, Serialize)]
pub enum BrowserTarget { Chrome, Brave, Edge, Firefox }

impl BrowserTarget {
    fn all() -> [BrowserTarget; 4] {
        [BrowserTarget::Chrome, BrowserTarget::Brave, BrowserTarget::Edge, BrowserTarget::Firefox]
    }

    /// Directory where the browser expects to find native-messaging
    /// host manifests. User-scope only.
    fn manifest_dir(self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        #[cfg(target_os = "macos")]
        {
            let p = match self {
                BrowserTarget::Chrome => "Library/Application Support/Google/Chrome/NativeMessagingHosts",
                BrowserTarget::Brave => "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
                BrowserTarget::Edge => "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
                BrowserTarget::Firefox => "Library/Application Support/Mozilla/NativeMessagingHosts",
            };
            Some(home.join(p))
        }
        #[cfg(target_os = "windows")]
        {
            // Windows doesn't use a per-browser directory; the manifest
            // lives wherever we want and is referenced by registry key.
            let _ = self;
            let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
            Some(local.join("ReDD Block").join("native-host"))
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
        "description": "ReDD Block native messaging host",
        "path": binary_path,
        "type": "stdio",
    });
    match browser {
        BrowserTarget::Firefox => {
            obj["allowed_extensions"] = json!([FIREFOX_EXT_ID]);
        }
        _ => {
            let mut origins = vec![format!("chrome-extension://{CHROMIUM_EXT_ID}/")];
            if cfg!(debug_assertions) {
                if let Ok(extra) = std::env::var("REDD_DEV_EXT_ID") {
                    for id in extra.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                        origins.push(format!("chrome-extension://{id}/"));
                    }
                }
            }
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

/// Install the native-messaging manifest for every supported browser.
pub fn install() -> std::io::Result<()> {
    let binary = current_binary_path().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "cannot resolve current exe")
    })?;

    for browser in BrowserTarget::all() {
        if let Err(e) = install_one(browser, &binary) {
            // Don't fail the whole operation for a single browser
            // (e.g. Firefox not installed). Log and continue.
            log::warn!("native-host install for {browser:?} failed: {e}");
        }
    }
    Ok(())
}

/// Remove the manifest for every supported browser. Safe to call even
/// if install never ran.
pub fn uninstall() -> std::io::Result<()> {
    for browser in BrowserTarget::all() {
        if let Err(e) = uninstall_one(browser) {
            log::warn!("native-host uninstall for {browser:?} failed: {e}");
        }
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install_one(browser: BrowserTarget, binary: &str) -> std::io::Result<()> {
    let dir = browser.manifest_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "cannot resolve manifest dir")
    })?;
    let path = dir.join(format!("{HOST_NAME}.json"));
    let body = manifest_body(browser, binary);
    let desired = serde_json::to_vec_pretty(&body)?;

    // Idempotent: skip create_dir_all + write when bytes already match.
    // On recent macOS, touching another app's Application Support tree
    // (even a no-op write) can surface TCC "access data from other apps"
    // prompts; skipping avoids re-prompting on every launch when the
    // manifest is already correct (same pattern as extension_install).
    if let Ok(existing) = std::fs::read(&path) {
        if existing == desired {
            log::info!(
                "native-host: manifest already current for {browser:?} at {} (skip)",
                path.display()
            );
            return Ok(());
        }
    }

    std::fs::create_dir_all(&dir)?;
    std::fs::write(&path, &desired)?;
    log::info!(
        "native-host: manifest written for {browser:?} at {}",
        path.display()
    );
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn uninstall_one(browser: BrowserTarget) -> std::io::Result<()> {
    let dir = browser.manifest_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "cannot resolve manifest dir")
    })?;
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
    // 1. Write the manifest to %LOCALAPPDATA%\ReDD Block\native-host\.
    let dir = browser.manifest_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::Other, "cannot resolve manifest dir")
    })?;
    std::fs::create_dir_all(&dir)?;
    let manifest_path = dir.join(format!("{HOST_NAME}-{}.json", browser_slug(browser)));
    let body = manifest_body(browser, binary);
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&body)?)?;

    // 2. Register the manifest path in HKCU.
    let registry_key = registry_key_path(browser);
    let manifest_str = manifest_path
        .to_str()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "non-utf8 manifest path"))?;
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
        BrowserTarget::Chrome => format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"),
        BrowserTarget::Brave => format!(r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{HOST_NAME}"),
        BrowserTarget::Edge => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}"),
        BrowserTarget::Firefox => format!(r"Software\Mozilla\NativeMessagingHosts\{HOST_NAME}"),
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
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("RegCreateKeyExW failed: {status:?}"),
            ));
        }
        let data_wide = to_wide(value);
        let bytes_len = (data_wide.len() * 2) as u32;
        let data_bytes = std::slice::from_raw_parts(
            data_wide.as_ptr() as *const u8,
            bytes_len as usize,
        );
        let _ = w!("");
        let status = RegSetValueExW(hkey, PCWSTR::null(), Some(0), REG_SZ, Some(data_bytes));
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("RegSetValueExW failed: {status:?}"),
            ));
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
            return Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("RegDeleteKeyW failed: {status:?}"),
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Tauri command wrappers.
#[tauri::command]
pub fn install_native_host() -> Result<(), String> {
    install().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn uninstall_native_host() -> Result<(), String> {
    uninstall().map_err(|e| e.to_string())
}
