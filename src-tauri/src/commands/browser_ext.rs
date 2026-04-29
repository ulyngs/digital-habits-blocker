// Tauri commands for browser-extension-based blocking (Windows path).
//
// The UI calls these during onboarding and background enforcement. All
// commands are desktop-only; on iOS the Screen Time API handles
// enforcement and these commands aren't registered.

use tauri::{AppHandle, Manager};

use crate::profile_scan;

/// Scan every supported browser profile for ReDD Focus extension
/// compliance. Returns the raw scan result so the UI can render a
/// per-browser status.
#[tauri::command]
pub async fn scan_browser_profiles() -> Result<profile_scan::ScanResult, String> {
    // Spawn on a blocking worker so the synchronous filesystem scan
    // doesn't block the Tauri async runtime.
    tauri::async_runtime::spawn_blocking(profile_scan::scan)
        .await
        .map_err(|e| format!("join error: {e}"))
}

/// Force the app to the foreground after a focus-stealing modal
/// (osascript admin prompt, file picker, etc.). Tauri's
/// `window.set_focus` from JS calls `makeKeyAndOrderFront` but does
/// NOT call `NSApp.activate(ignoringOtherApps:)` — required when
/// the app runs as a menu-bar accessory (no Dock icon) so there's
/// no Dock click to bring the process back to the front.
#[tauri::command]
pub fn activate_app(window: tauri::Window) {
    reveal_app(&window.app_handle());
}

pub fn reveal_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSApp;
        use cocoa::base::YES;
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            #[allow(unexpected_cfgs)]
            let app = NSApp();
            let _: () = msg_send![app, activateIgnoringOtherApps: YES];
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// True when every running-and-present browser is compliant. Shortcut
/// for the onboarding gate; the UI can also derive this itself from
/// `scan_browser_profiles`.
#[tauri::command]
pub async fn browser_profiles_compliant() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let r = profile_scan::scan();
        profile_scan::compliant(&r)
    })
    .await
    .map_err(|e| format!("join error: {e}"))
}

/// Open the browser's extension-management UI so the user can enable
/// ReDD Focus or allow it in private/incognito windows.
#[tauri::command]
pub fn open_browser_extension_settings(browser: String) -> Result<(), String> {
    let browser = browser.trim();
    let normalized = browser.to_ascii_lowercase();
    let chromium_id = crate::native_host_install::CHROMIUM_EXT_ID;
    let url = match normalized.as_str() {
        "firefox" => "about:addons".to_string(),
        "safari" => "x-apple.systempreferences:com.apple.ExtensionsPreferences?".to_string(),
        _ => format!("chrome://extensions/?id={chromium_id}"),
    };

    #[cfg(target_os = "macos")]
    {
        if normalized == "safari" {
            let out = std::process::Command::new("/usr/bin/open")
                .arg(&url)
                .output()
                .map_err(|e| format!("spawn /usr/bin/open: {e}"))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Err(format!(
                    "`open {url}` exited with {}: {}",
                    out.status,
                    stderr.trim()
                ));
            }
            return Ok(());
        }

        let app_name = match normalized.as_str() {
            "brave" => "Brave Browser",
            "edge" => "Microsoft Edge",
            "firefox" => "Firefox",
            _ => "Google Chrome",
        };
        let out = std::process::Command::new("/usr/bin/open")
            .args(["-a", app_name, &url])
            .output()
            .map_err(|e| format!("spawn /usr/bin/open: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "`open -a {app_name}` exited with {}: {}",
                out.status,
                stderr.trim()
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let exe = match normalized.as_str() {
            "brave" => Some("brave.exe"),
            "edge" => Some("msedge.exe"),
            "firefox" => Some("firefox.exe"),
            "chrome" => Some("chrome.exe"),
            _ => None,
        };
        let args: Vec<String> = match exe {
            Some(browser_exe) => vec![
                "/c".into(),
                "start".into(),
                "".into(),
                browser_exe.into(),
                url.clone(),
            ],
            None => vec!["/c".into(), "start".into(), "".into(), url.clone()],
        };
        let out = std::process::Command::new("cmd")
            .args(&args)
            .output()
            .map_err(|e| format!("spawn cmd start: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "`cmd /c start` exited with {}: {}",
                out.status,
                stderr.trim()
            ));
        }
        Ok(())
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = url;
        Err("open_browser_extension_settings unsupported on this platform".into())
    }
}
