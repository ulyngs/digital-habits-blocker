// Tauri commands for browser-extension-based blocking (Windows path).
//
// The UI calls these during onboarding and background enforcement. All
// commands are desktop-only; on iOS the Screen Time API handles
// enforcement and these commands aren't registered.

use std::sync::Mutex;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition};

use crate::profile_scan;

/// Geometry of the main window before we shrink it for the app-blocking
/// force-quit countdown. Restored when the last warning layer clears.
#[derive(Clone, Copy)]
struct SavedWindowGeom {
    inner_w: f64,
    inner_h: f64,
    outer_x: i32,
    outer_y: i32,
}

static BLOCKING_WARNING_SAVED_GEOM: Mutex<Option<SavedWindowGeom>> = Mutex::new(None);

/// Matches `WebviewWindowBuilder` min on macOS / Windows.
const MAIN_RESTORE_MIN_W: f64 = 600.0;
const MAIN_RESTORE_MIN_H: f64 = 500.0;

/// Inner width (logical points) for the warning-only shell — frontend
/// measures height and calls [`resize_blocking_warning_inner_size`].
const WARNING_COMPACT_W: f64 = 592.0;

/// Short-lived bootstrap height before JS fits the window to content.
const WARNING_COMPACT_BOOTSTRAP_H: f64 = 360.0;

/// Loose bounds so we can shrink below the normal 600×500 app min. The
/// height floor needs to be small enough that the compact scheduled-block
/// heads-up card (which is shorter than the force-quit warning) doesn't
/// get padded out by an oversized window — `syncBlockingWarningWindowToContent`
/// clamps the measured height to this floor.
const WARNING_SHELL_MIN_W: f64 = 480.0;
const WARNING_SHELL_MIN_H: f64 = 200.0;

/// Cap so an enormous block list cannot create an unusably tall window.
const WARNING_SHELL_MAX_H: f64 = 1280.0;

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
/// the app is sitting in Accessory mode (no Dock icon) so there's
/// no Dock click to bring the process back to the front.
#[tauri::command]
pub fn activate_app(window: tauri::Window) {
    reveal_app(&window.app_handle());
}

/// Show the main window and put the app in Regular activation
/// policy (Dock icon + menu bar visible). Used by the tray click,
/// the dock-icon Reopen handler, the "Reopen Main Window" menu
/// item, and the enforcer when it surfaces compliance alerts.
pub fn reveal_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // Promote to Regular *before* showing so the window comes up
        // alongside the Dock icon / app menu instead of flashing
        // without them.
        crate::set_macos_activation_policy(true);
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

/// Best-effort: bring another process (`pid`) forward so dialogs and
/// save prompts are plainly visible — used before graceful quit attempts.
#[cfg(target_os = "macos")]
pub fn activate_external_process_by_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    use cocoa::base::{id, YES};
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let Some(class) = Class::get("NSRunningApplication") else {
            log::warn!("activate_external_process_by_pid: NSRunningApplication class missing");
            return;
        };
        let raw_pid = pid as i32;
        let app: id = msg_send![class, runningApplicationWithProcessIdentifier: raw_pid];
        if app.is_null() {
            log::debug!("activate_external_process_by_pid: no app for pid {pid}");
            return;
        }
        // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
        let options: u64 = 1 | 2;
        let ok: cocoa::base::BOOL = msg_send![app, activateWithOptions: options];
        if ok != YES {
            log::debug!("activate_external_process_by_pid: activateWithOptions(NO) pid={pid}");
        }
    }
}

#[cfg(target_os = "windows")]
pub fn activate_external_process_by_pid(target_pid: u32) {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        AttachThreadInput, EnumWindows, GetForegroundWindow, GetWindow,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
        GW_OWNER, SW_RESTORE,
    };

    struct FindCtx {
        target_pid: u32,
        hwnd: Option<HWND>,
    }

    unsafe extern "system" fn pick_top_level(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut FindCtx);
        if !IsWindowVisible(hwnd).as_bool() {
            return windows::Win32::Foundation::TRUE;
        }
        let owner = GetWindow(hwnd, GW_OWNER);
        if !owner.is_invalid() && owner != HWND::default() {
            return windows::Win32::Foundation::TRUE;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != ctx.target_pid {
            return windows::Win32::Foundation::TRUE;
        }
        ctx.hwnd = Some(hwnd);
        windows::Win32::Foundation::FALSE // stop enumeration
    }

    unsafe {
        let mut ctx = FindCtx {
            target_pid,
            hwnd: None,
        };
        let ptr = (&mut ctx) as *mut FindCtx as isize;
        let _ = EnumWindows(Some(pick_top_level), LPARAM(ptr));

        let Some(hwnd) = ctx.hwnd else {
            log::debug!("activate_external_process_by_pid: no hwnd for pid {target_pid}");
            return;
        };

        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }

        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            let _ = SetForegroundWindow(hwnd);
            return;
        }

        let mut _fg_pid = 0u32;
        let fg_tid = GetWindowThreadProcessId(fg, Some(&mut _fg_pid));
        let mut _win_pid = 0u32;
        let tgt_tid = GetWindowThreadProcessId(hwnd, Some(&mut _win_pid));
        let _ = AttachThreadInput(fg_tid, tgt_tid, true.into());
        let _ = SetForegroundWindow(hwnd);
        let _ = AttachThreadInput(fg_tid, tgt_tid, false.into());
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub fn activate_external_process_by_pid(_pid: u32) {}

/// Visible compact warning chrome without activating ReDD Block as the key
/// app — keeps keyboard focus with the blocked app so the user can type in
/// save dialogs while the countdown stays `always_on_top`.
#[cfg(target_os = "macos")]
pub fn show_blocking_warning_shell_without_stealing_focus(app: &AppHandle) {
    use cocoa::base::{id, nil, YES};
    use objc::{msg_send, sel, sel_impl};

    let handle = app.clone();
    let handle_in_closure = handle.clone();
    if let Err(e) = handle.run_on_main_thread(move || {
        let Some(win) = handle_in_closure.get_webview_window("main") else {
            return;
        };
        let _ = win.unminimize();
        match win.ns_window() {
            Ok(raw) => {
                let ns_window = raw as id;
                unsafe {
                    let _: () = msg_send![ns_window, deminiaturize: nil];
                    let _: () = msg_send![ns_window, setIsVisible: YES];
                    let _: () = msg_send![ns_window, orderFront: nil];
                }
            }
            Err(_) => {
                let _ = win.show();
            }
        }
    }) {
        log::warn!("show_blocking_warning_shell_without_stealing_focus: main thread: {e:?}");
    }
}

#[cfg(target_os = "windows")]
pub fn show_blocking_warning_shell_without_stealing_focus(app: &AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };

    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    match win.hwnd() {
        Ok(hwnd) => unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE;
            let _ = SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, flags);
        },
        Err(_) => {
            let _ = win.unminimize();
            let _ = win.show();
        }
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub fn show_blocking_warning_shell_without_stealing_focus(_app: &AppHandle) {}

/// While the app-blocking force-quit warning is visible, keep the main
/// window above normal windows and on every desktop Space — including
/// when a blocked app is in macOS fullscreen, where the countdown would
/// otherwise be invisible on another Space.
pub fn set_blocking_warning_attention(app: &AppHandle, active: bool) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let _ = w.set_always_on_top(active);
    let _ = w.set_visible_on_all_workspaces(active);

    #[cfg(target_os = "macos")]
    apply_macos_blocking_warning_panel_mode(app, active);
}

/// Switch the main window between "regular app window" and "redd-do-style
/// pop-out NSPanel" modes. The window's underlying class is already an
/// NSPanel subclass (see `MainPanel` in `lib.rs`); here we only flip the
/// runtime properties that distinguish a panel-style overlay:
///
/// * `NSWindowStyleMaskNonactivatingPanel` — the panel can come to the
///   front without making ReDD Block the active app, so the user can keep
///   typing into the save dialog of the blocked app.
/// * `PanelLevel::Floating` — sits above normal windows.
/// * `FullScreenAuxiliary` collection behavior — the missing piece that
///   lets the panel join and float over a third-party fullscreen Space
///   (`canJoinAllSpaces` alone is not enough).
///
/// On exit we restore the regular main-window style mask + level +
/// default collection behavior so the app behaves normally again.
///
/// All three setters dispatch into AppKit, which asserts main-thread-only
/// — but our caller (`app_watcher`) lives on a background thread, so
/// dispatch the whole flip via `run_on_main_thread`. (Tauri's own
/// `set_always_on_top` / `set_visible_on_all_workspaces` do this for you;
/// the tauri-nspanel panel API does not.)
#[cfg(target_os = "macos")]
fn apply_macos_blocking_warning_panel_mode(app: &AppHandle, active: bool) {
    use tauri_nspanel::{
        objc2_app_kit::NSWindowStyleMask, CollectionBehavior, ManagerExt, PanelLevel, StyleMask,
    };

    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        // The main window was converted to an NSPanel-backed `MainPanel`
        // at setup. If the panel handle is missing here we're either
        // being called before that ran (very early startup) or after
        // the window was destroyed — in either case the legacy
        // `set_always_on_top` / `set_visible_on_all_workspaces` calls
        // already gave us a best-effort overlay, so we just log and
        // return.
        let panel = match handle.get_webview_panel("main") {
            Ok(p) => p,
            Err(e) => {
                log::warn!("set_blocking_warning_attention: main panel missing: {e:?}");
                return;
            }
        };

        // The main window's baseline style mask matches the
        // `WebviewWindowBuilder` config: titled (with `TitleBarStyle::Overlay`
        // contributing `FullSizeContentView`), closable, miniaturizable,
        // resizable. We add/remove only the `NonactivatingPanel` bit on
        // top of that so the title-bar layout stays stable across the
        // switch.
        let base_mask: NSWindowStyleMask = StyleMask::new().full_size_content_view().into();

        if active {
            panel.set_style_mask(base_mask | NSWindowStyleMask::NonactivatingPanel);
            panel.set_level(PanelLevel::Floating.value());
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .stationary()
                    .full_screen_auxiliary()
                    .ignores_cycle()
                    .into(),
            );
        } else {
            panel.set_style_mask(base_mask);
            panel.set_level(PanelLevel::Normal.value());
            panel.set_collection_behavior(CollectionBehavior::new().into());
        }
    }) {
        log::warn!("apply_macos_blocking_warning_panel_mode: main thread: {e:?}");
    }
}

/// Expands the main window to cover the full display (NOT macOS native
/// fullscreen — no Space change, no menu-bar hide; just sized to the
/// monitor's logical width × height) and toggles the warning CSS mode.
/// Snapshots prior geometry so [`leave_blocking_warning_compact_window`]
/// can restore the user's previous window size on exit.
///
/// The function name still says "compact" for now to keep the call sites
/// in `app_watcher` untouched — the warning UX it powers has flipped
/// from "tiny floating card" to "full-screen take-over", but the
/// enter/leave protocol is the same.
#[cfg(not(target_os = "ios"))]
pub fn enter_blocking_warning_compact_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };

    // On Windows, the main window is typically hidden in the system
    // tray between sessions. `set_size` / `set_position` on a hidden
    // window don't reliably take effect when the window is later
    // shown, and `current_monitor()` returns inconsistent results for
    // a hidden window — so unminimize + show it FIRST. (On macOS we
    // leave this to `show_blocking_warning_shell_without_stealing_focus`,
    // which uses `orderFront:` to avoid stealing focus from the blocked
    // app the user just tried to launch.)
    #[cfg(target_os = "windows")]
    {
        let _ = w.unminimize();
        let _ = w.show();
    }

    {
        let Ok(mut slot) = BLOCKING_WARNING_SAVED_GEOM.lock() else {
            return;
        };
        if slot.is_none() {
            let scale = w.scale_factor().unwrap_or(1.0);
            match (w.inner_size(), w.outer_position()) {
                (Ok(inner), Ok(outer)) => {
                    *slot = Some(SavedWindowGeom {
                        inner_w: inner.width as f64 / scale,
                        inner_h: inner.height as f64 / scale,
                        outer_x: outer.x,
                        outer_y: outer.y,
                    });
                }
                _ => {
                    log::warn!(
                        "blocking warning: could not read window geometry — full-screen shell skipped"
                    );
                    return;
                }
            }
        }
    }

    const MODE_ON: &str = r#"(function(){
  try {
    document.documentElement.classList.add('app-blocking-warning-window-mode');
    document.body.classList.add('app-blocking-warning-window-mode');
  } catch (_) {}
})();"#;

    let _ = w.eval(MODE_ON);

    // Size the window to cover the full display. We prefer
    // `primary_monitor()` because it returns deterministic values
    // even for windows that were just shown / are still positioned at
    // negative coords from a previous session — `current_monitor()`
    // can return None or the wrong monitor in those edge cases. NOT
    // native fullscreen — just an oversized borderless panel sized to
    // the monitor, so the user can't ignore the warning by dragging
    // another window over it.
    let monitor = w
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| w.current_monitor().ok().flatten());

    if let Some(m) = monitor {
        let scale = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        log::info!(
            "blocking warning: sizing main window to {}x{} @ {:?} (scale {:.2})",
            logical_w as i32,
            logical_h as i32,
            (pos.x, pos.y),
            scale,
        );
        let _ = w.set_min_size(Some(LogicalSize::new(WARNING_SHELL_MIN_W, WARNING_SHELL_MIN_H)));
        let _ = w.set_size(LogicalSize::new(logical_w, logical_h));
        let _ = w.set_position(PhysicalPosition::new(pos.x, pos.y));
    } else {
        // Fall back to a generous fixed size if monitor metadata isn't
        // available — better than rendering tiny.
        log::warn!("blocking warning: no monitor metadata — falling back to 1440x900");
        let _ = w.set_min_size(Some(LogicalSize::new(WARNING_SHELL_MIN_W, WARNING_SHELL_MIN_H)));
        let _ = w.set_size(LogicalSize::new(1440.0, 900.0));
        let _ = w.center();
    }
}

/// Sets main window **inner** logical size from measured webview content (no
/// `center()` — preserves user drag). Used to drop the empty margin below
/// the force-quit warning once the DOM has laid out.
#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn resize_blocking_warning_inner_size(
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }
    let iw = width.clamp(WARNING_SHELL_MIN_W, 960.0);
    let ih = height.clamp(WARNING_SHELL_MIN_H, WARNING_SHELL_MAX_H);
    window
        .set_size(LogicalSize::new(iw, ih))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Frontend-callable entry into the same panel-overlay refcount the
/// app-blocking force-quit watcher uses. Lets JS trigger the always-on-
/// top compact-window mode for non-watcher warnings (e.g. the heads-up
/// before a scheduled block starts), so app-blocking and schedule
/// warnings share one refcount and panel mode stays on as long as any
/// warning layer is up.
#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn enter_blocking_warning_panel_mode(app: AppHandle) {
    crate::app_watcher::blocking_warning_begin(Some(&app));
}

#[tauri::command]
#[cfg(not(target_os = "ios"))]
pub fn leave_blocking_warning_panel_mode(app: AppHandle) {
    crate::app_watcher::blocking_warning_end(Some(&app));
}

// On iOS the compact-window / panel machinery is no-op anyway, but we
// still register the commands so the JS `invoke` calls don't fail.
#[tauri::command]
#[cfg(target_os = "ios")]
pub fn enter_blocking_warning_panel_mode(_app: AppHandle) {}

#[tauri::command]
#[cfg(target_os = "ios")]
pub fn leave_blocking_warning_panel_mode(_app: AppHandle) {}

#[cfg(target_os = "ios")]
pub fn enter_blocking_warning_compact_window(_app: &AppHandle) {}

#[cfg(not(target_os = "ios"))]
pub fn leave_blocking_warning_compact_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };

    const MODE_OFF: &str = r#"(function(){
  try {
    document.documentElement.classList.remove('app-blocking-warning-window-mode');
    document.body.classList.remove('app-blocking-warning-window-mode');
  } catch (_) {}
})();"#;

    let _ = w.eval(MODE_OFF);

    let saved = BLOCKING_WARNING_SAVED_GEOM
        .lock()
        .ok()
        .and_then(|mut g| g.take());

    let _ = w.set_min_size(Some(LogicalSize::new(
        MAIN_RESTORE_MIN_W,
        MAIN_RESTORE_MIN_H,
    )));

    if let Some(g) = saved {
        let _ = w.set_size(LogicalSize::new(g.inner_w, g.inner_h));
        let _ = w.set_position(PhysicalPosition::new(g.outer_x, g.outer_y));
    }
}

#[cfg(target_os = "ios")]
pub fn leave_blocking_warning_compact_window(_app: &AppHandle) {}

/// Hide the main window to the tray and drop the macOS Dock icon /
/// menu bar (Accessory activation policy). Invoked from the
/// custom title-bar close button in the frontend; the Cmd-Q and
/// red-X paths go through `should_terminate` and the
/// `CloseRequested` handler respectively, both of which apply the
/// same policy flip directly.
#[tauri::command]
pub fn hide_main_window(window: tauri::Window) {
    let app = window.app_handle().clone();
    let app_for_main = app.clone();
    // Both `NSWindow.orderOut` and `setActivationPolicy:` should
    // happen on the AppKit main thread, so dispatch there.
    let _ = app.run_on_main_thread(move || {
        if let Some(main) = app_for_main.get_webview_window("main") {
            let _ = main.hide();
        }
        #[cfg(target_os = "macos")]
        crate::set_macos_activation_policy(false);
    });
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
        _ => format!("chrome://extensions/?id={chromium_id}"),
    };

    #[cfg(target_os = "macos")]
    {
        if normalized == "safari" {
            // Safari extensions are managed in Safari > Settings > Extensions.
            // Use osascript to open the Extensions pane directly.
            let script = concat!(
                "tell application \"Safari\" to activate\n",
                "delay 0.3\n",
                "tell application \"System Events\"\n",
                "  tell process \"Safari\"\n",
                "    keystroke \",\" using command down\n",
                "    delay 0.5\n",
                "    click button \"Extensions\" of toolbar 1 of window 1\n",
                "  end tell\n",
                "end tell\n",
            );
            let out = std::process::Command::new("osascript")
                .args(["-e", script])
                .output()
                .map_err(|e| format!("osascript: {e}"))?;
            if !out.status.success() {
                // If AppleScript failed (e.g. no accessibility permission),
                // fall back to just activating Safari.
                log::warn!(
                    "osascript for Safari settings failed ({}), activating Safari",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
                let _ = std::process::Command::new("/usr/bin/open")
                    .args(["-a", "Safari"])
                    .output();
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
        // Reuse the same exe-path lookup that profile_scan uses for
        // install detection.  Launching the browser directly (instead
        // of `cmd /c start`) avoids slow PATH searches and ensures
        // chrome:// URLs aren't mangled by cmd's argument parser.
        let exe = profile_scan::find_browser_exe(&normalized)
            .ok_or_else(|| format!("Could not find {browser} executable"))?;
        std::process::Command::new(&exe)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("launch {}: {e}", exe.display()))?;
        Ok(())
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = url;
        Err("open_browser_extension_settings unsupported on this platform".into())
    }
}

/// Open a specific URL in a specific browser.  Used by the enforcer
/// "Install ReDD Focus" button so the store page opens in the correct
/// browser instead of triggering the OS "choose an app" dialog.
#[tauri::command]
pub fn open_url_in_browser(browser: String, url: String) -> Result<(), String> {
    let normalized = browser.trim().to_ascii_lowercase();

    #[cfg(target_os = "macos")]
    {
        let app_name = match normalized.as_str() {
            "brave" => "Brave Browser",
            "edge" => "Microsoft Edge",
            "firefox" => "Firefox",
            "safari" => "Safari",
            _ => "Google Chrome",
        };
        std::process::Command::new("/usr/bin/open")
            .args(["-a", app_name, &url])
            .output()
            .map_err(|e| format!("open -a {app_name}: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        let exe = profile_scan::find_browser_exe(&normalized)
            .ok_or_else(|| format!("Could not find {browser} executable"))?;
        std::process::Command::new(&exe)
            .arg(&url)
            .spawn()
            .map_err(|e| format!("launch {}: {e}", exe.display()))?;
        Ok(())
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = (url, normalized);
        Err("open_url_in_browser unsupported on this platform".into())
    }
}
