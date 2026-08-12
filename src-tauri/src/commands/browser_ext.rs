#![allow(deprecated)]
// The macOS FFI in this module goes through the `cocoa` crate, whose entire
// surface is deprecated in favour of `objc2`. That migration is real work and
// unrelated to what this module does; scoping the allow here keeps the
// `-D warnings` clippy gate meaningful for every other lint.

// Tauri commands for browser-extension-based blocking (Windows path).
//
// The UI calls these during onboarding and background enforcement. All
// commands are desktop-only; on iOS the Screen Time API handles
// enforcement and these commands aren't registered.

use std::sync::Mutex;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

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
static BLOCKING_WARNING_AUX_WINDOWS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Matches `WebviewWindowBuilder` min on macOS / Windows.
const MAIN_RESTORE_MIN_W: f64 = 400.0;
const MAIN_RESTORE_MIN_H: f64 = 360.0;

/// Inner width (logical points) for the warning-only shell — frontend
/// measures height and calls [`resize_blocking_warning_inner_size`].
// Used by the Windows app-blocking warning window.
#[allow(dead_code)]
const WARNING_COMPACT_W: f64 = 592.0;

/// Short-lived bootstrap height before JS fits the window to content.
#[allow(dead_code)]
const WARNING_COMPACT_BOOTSTRAP_H: f64 = 360.0;

/// Loose bounds so we can shrink below the normal app min. The
/// height floor needs to be small enough that the compact scheduled-block
/// heads-up card (which is shorter than the force-quit warning) doesn't
/// get padded out by an oversized window — `syncBlockingWarningWindowToContent`
/// clamps the measured height to this floor.
const WARNING_SHELL_MIN_W: f64 = 480.0;
const WARNING_SHELL_MIN_H: f64 = 200.0;

/// Cap so an enormous block list cannot create an unusably tall window.
const WARNING_SHELL_MAX_H: f64 = 1280.0;

/// True when Firefox is installed on this machine (app bundle / exe on
/// disk). Used by the welcome screen before a full profile scan.
#[tauri::command]
pub fn is_firefox_installed() -> bool {
    profile_scan::firefox_app_installed()
}

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
    reveal_app(window.app_handle());
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
    #[cfg(target_os = "macos")]
    ensure_macos_traffic_lights_visible(app);
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
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::System::Threading::AttachThreadInput;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindow, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };

    struct FindCtx {
        target_pid: u32,
        hwnd: Option<HWND>,
    }

    unsafe extern "system" fn pick_top_level(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut FindCtx);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1); // continue enumeration
        }
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if owner != HWND::default() {
            return BOOL(1); // continue enumeration
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != ctx.target_pid {
            return BOOL(1); // continue enumeration
        }
        ctx.hwnd = Some(hwnd);
        BOOL(0) // stop enumeration
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
        if fg == HWND::default() {
            let _ = SetForegroundWindow(hwnd);
            return;
        }

        let mut _fg_pid = 0u32;
        let fg_tid = GetWindowThreadProcessId(fg, Some(&mut _fg_pid));
        let mut _win_pid = 0u32;
        let tgt_tid = GetWindowThreadProcessId(hwnd, Some(&mut _win_pid));
        let _ = AttachThreadInput(fg_tid, tgt_tid, true);
        let _ = SetForegroundWindow(hwnd);
        let _ = AttachThreadInput(fg_tid, tgt_tid, false);
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub fn activate_external_process_by_pid(_pid: u32) {}

/// Visible compact warning chrome without activating Digital Habits: Blocker as the key
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
        SetWindowPos, ShowWindow, HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
        SW_SHOWNOACTIVATE,
    };

    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    match win.hwnd() {
        Ok(hwnd) => unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE;
            let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, flags);
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
///
/// When an in-app installer has asked us to yield z-order, the Let's go
/// shell still joins all Spaces and keeps its full-monitor frame, but it
/// does **not** take Floating / always-on-top — otherwise Installer.app
/// (normal window level) stays buried behind the shell.
pub fn set_blocking_warning_attention(app: &AppHandle, active: bool) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let yield_for_installer = active && installer_zorder_yield_active();
    let always_on_top = active && !yield_for_installer;
    let _ = w.set_always_on_top(always_on_top);
    // Keep Space joining for the full-screen shell even while yielded —
    // flipping `visible_on_all_workspaces` off is what warps the frame
    // when focus moves to the follow-instructions dialog / Installer.
    let _ = w.set_visible_on_all_workspaces(active);

    #[cfg(target_os = "macos")]
    apply_macos_blocking_warning_panel_mode(app, active, yield_for_installer);

    if active {
        set_aux_blocking_warning_always_on_top(app, always_on_top);
        if yield_for_installer {
            // Shell `orderFront` / resize can cover Installer; ask the
            // handoff thread to re-front it on the next poll.
            request_installer_activate();
        }
    }
}

/// How many in-app installer launches currently need the warning shell to
/// yield z-order. Ref-counted so a second Reinstall click cannot restore
/// always-on-top while an earlier installer is still open.
///
/// Depth is tracked even when the Let's go shell is not yet visible: if
/// the shell appears while the installer is still open, attention must
/// stay yielded so Floating is not re-applied on top of Installer.
static INSTALLER_ZORDER_YIELD_DEPTH: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(0);

/// Set when the Let's go shell (re)appears during an installer yield so the
/// handoff thread can re-front Installer after our `orderFront`.
static INSTALLER_ACTIVATE_REQUESTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn installer_zorder_yield_active() -> bool {
    use std::sync::atomic::Ordering;
    INSTALLER_ZORDER_YIELD_DEPTH.load(Ordering::SeqCst) > 0
}

/// True when the handoff thread should bring the installer forward now
/// (clears the one-shot request).
pub fn take_installer_activate_request() -> bool {
    use std::sync::atomic::Ordering;
    INSTALLER_ACTIVATE_REQUESTED.swap(false, Ordering::SeqCst)
}

fn request_installer_activate() {
    use std::sync::atomic::Ordering;
    INSTALLER_ACTIVATE_REQUESTED.store(true, Ordering::SeqCst);
}

/// Mark that an external installer needs to sit above the Let's go shell.
/// Always pairs with [`restore_blocking_warning_zorder_after_installer`].
///
/// Does **not** dismiss the Let's go UI, change its geometry, or touch the
/// warning refcount. If the shell is already up, drops only Floating /
/// always-on-top while keeping Space-joining collection behavior so the
/// full-screen frame does not warp.
pub fn yield_blocking_warning_zorder_for_installer(app: &AppHandle) {
    use std::sync::atomic::Ordering;

    let prev = INSTALLER_ZORDER_YIELD_DEPTH.fetch_add(1, Ordering::SeqCst);
    if prev != 0 {
        return;
    }
    log::info!("blocking warning: yielding z-order for installer");
    if crate::app_watcher::blocking_warning_shell_active() {
        // Re-apply attention with yield depth > 0 → Normal level, no AOT,
        // same collection behavior / geometry. Ask the handoff thread to
        // front Installer only while this shell is up.
        request_installer_activate();
        set_blocking_warning_attention(app, true);
    }
}

/// Re-apply always-on-top after the installer has exited, but only if the
/// Let's go warning is still active (user cancelled install instead of
/// proceeding). No-op when another installer launch still holds the yield.
pub fn restore_blocking_warning_zorder_after_installer(app: &AppHandle) {
    use std::sync::atomic::Ordering;

    let prev = INSTALLER_ZORDER_YIELD_DEPTH
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
            Some(v.saturating_sub(1))
        })
        .unwrap_or(0);
    if prev != 1 {
        return;
    }
    if !crate::app_watcher::blocking_warning_shell_active() {
        return;
    }
    log::info!("blocking warning: restoring z-order after installer");
    set_blocking_warning_attention(app, true);
}

fn set_aux_blocking_warning_always_on_top(app: &AppHandle, active: bool) {
    let labels = BLOCKING_WARNING_AUX_WINDOWS
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_always_on_top(active);
        }
    }
}

/// Switch the main window between "regular app window" and "redd-do-style
/// pop-out NSPanel" modes. The window's underlying class is already an
/// NSPanel subclass (see `MainPanel` in `lib.rs`); here we only flip the
/// runtime properties that distinguish a panel-style overlay:
///
/// * `NSWindowStyleMaskNonactivatingPanel` — the panel can come to the
///   front without making Digital Habits: Blocker the active app, so the user can keep
///   typing into the save dialog of the blocked app.
/// * `PanelLevel::Floating` — sits above normal windows (skipped while an
///   installer yield is active so Installer.app can appear above the shell).
/// * `FullScreenAuxiliary` collection behavior — the missing piece that
///   lets the panel join and float over a third-party fullscreen Space
///   (`canJoinAllSpaces` alone is not enough).
///
/// While `yield_for_installer` is set we keep NonactivatingPanel + the
/// Space-joining collection behavior and only drop to `PanelLevel::Normal`.
/// Clearing collection behavior (the old yield path) relocates the
/// full-monitor frame when focus moves — that's the "Let's go warped off
/// the edges" bug.
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
fn apply_macos_blocking_warning_panel_mode(
    app: &AppHandle,
    active: bool,
    yield_for_installer: bool,
) {
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
            panel.set_level(if yield_for_installer {
                PanelLevel::Normal.value()
            } else {
                PanelLevel::Floating.value()
            });
            // Keep this collection behavior for the whole shell lifetime —
            // including installer yield — so the full-monitor geometry stays put.
            panel.set_collection_behavior(
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .stationary()
                    .full_screen_auxiliary()
                    .ignores_cycle()
                    .into(),
            );
            // Let's go is an enforcement gate — hide traffic lights so the
            // user cannot minimize/close the shell as if the block never
            // started. Restored on leave (and after style-mask flips which
            // can recreate the buttons).
            set_macos_traffic_lights_visible_now(&handle, false);
        } else {
            panel.set_style_mask(base_mask);
            panel.set_level(PanelLevel::Normal.value());
            panel.set_collection_behavior(CollectionBehavior::new().into());
            set_macos_traffic_lights_visible_now(&handle, true);
        }
    }) {
        log::warn!("apply_macos_blocking_warning_panel_mode: main thread: {e:?}");
    }
}

/// Show or hide the standard macOS close / minimize / zoom buttons on the
/// AppKit main thread. Callers may be on a watcher or command thread.
#[cfg(target_os = "macos")]
fn set_macos_traffic_lights_visible(app: &AppHandle, visible: bool) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        set_macos_traffic_lights_visible_now(&handle, visible);
    }) {
        log::warn!("set_macos_traffic_lights_visible: main thread: {e:?}");
    }
}

/// The raw AppKit operation. This must only be called from the main thread.
#[cfg(target_os = "macos")]
fn set_macos_traffic_lights_visible_now(app: &AppHandle, visible: bool) {
    use cocoa::base::{id, nil, NO, YES};
    use objc::{msg_send, sel, sel_impl};

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(raw_window) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = raw_window as id;
        let hidden = if visible { NO } else { YES };
        // 0 = close, 1 = miniaturize, 2 = zoom
        for button_kind in [0usize, 1, 2] {
            let button: id = msg_send![ns_window, standardWindowButton: button_kind];
            if button != nil {
                let _: () = msg_send![button, setHidden: hidden];
            }
        }
    }
}

/// Force the standard macOS close / minimize / zoom buttons to be visible.
/// Used after normal window create / reopen so chrome isn't left hidden by
/// a prior warning-panel transition.
#[cfg(target_os = "macos")]
pub fn ensure_macos_traffic_lights_visible(app: &AppHandle) {
    set_macos_traffic_lights_visible(app, true);
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

    let monitor = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten());

    if let Some(m) = monitor {
        let warning_size = monitor_logical_size(&m);
        let _ = w.set_size(warning_size);
        let _ = w.set_min_size(Some(warning_size));
        let _ = w.set_max_size(Some(warning_size));
        let _ = w.set_position(PhysicalPosition::new(m.position().x, m.position().y));
        create_aux_blocking_warning_windows(app, m.position().x, m.position().y);
    } else {
        // Fall back to a generous fixed size if monitor metadata isn't
        // available — better than rendering tiny.
        let warning_size = LogicalSize::new(1440.0, 900.0);
        let _ = w.set_size(warning_size);
        let _ = w.set_min_size(Some(warning_size));
        let _ = w.set_max_size(Some(warning_size));
        let _ = w.center();
    }
}

#[cfg(not(target_os = "ios"))]
fn monitor_logical_size(monitor: &tauri::Monitor) -> LogicalSize<f64> {
    let scale = monitor.scale_factor();
    let size = monitor.size();
    LogicalSize::new(size.width as f64 / scale, size.height as f64 / scale)
}

#[cfg(not(target_os = "ios"))]
fn create_aux_blocking_warning_windows(app: &AppHandle, main_x: i32, main_y: i32) {
    close_aux_blocking_warning_windows(app);

    let Some(main_window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(monitors) = main_window.available_monitors() else {
        return;
    };

    let mut labels = Vec::new();
    for (idx, monitor) in monitors.iter().enumerate() {
        let pos = monitor.position();
        if pos.x == main_x && pos.y == main_y {
            continue;
        }

        let label = format!("blocking-warning-aux-{idx}");
        let warning_size = monitor_logical_size(monitor);
        let html = aux_blocking_warning_html();
        let url = WebviewUrl::External("about:blank".parse().unwrap());
        // Match main-window yield: stay on all Spaces, but don't float above
        // Installer while an in-app reinstall is in progress.
        let always_on_top = !installer_zorder_yield_active();
        let builder = WebviewWindowBuilder::new(app, &label, url)
            .title("")
            .decorations(false)
            .resizable(false)
            .always_on_top(always_on_top)
            .visible_on_all_workspaces(true)
            .inner_size(warning_size.width, warning_size.height)
            .position(pos.x as f64, pos.y as f64)
            .initialization_script(format!(
                r#"
                window.addEventListener('DOMContentLoaded', () => {{
                    document.open();
                    document.write({html:?});
                    document.close();
                }});
                "#
            ));

        match builder.build() {
            Ok(window) => {
                let _ = window.set_position(PhysicalPosition::new(pos.x, pos.y));
                labels.push(label);
            }
            Err(e) => log::warn!("blocking warning: aux display window failed: {e:?}"),
        }
    }

    if let Ok(mut slot) = BLOCKING_WARNING_AUX_WINDOWS.lock() {
        *slot = labels;
    }
}

#[cfg(not(target_os = "ios"))]
fn close_aux_blocking_warning_windows(app: &AppHandle) {
    let labels = BLOCKING_WARNING_AUX_WINDOWS
        .lock()
        .ok()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default();

    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    }
}

#[cfg(not(target_os = "ios"))]
fn aux_blocking_warning_html() -> &'static str {
    r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #ffffff;
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body {
  display: flex;
  align-items: center;
  justify-content: center;
}
.card {
  width: min(560px, calc(100vw - 96px));
  box-sizing: border-box;
  padding: 40px 48px;
  border-radius: 24px;
  background: #ffffff;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.18);
  color: #1f2937;
  text-align: center;
}
.emoji { font-size: 56px; line-height: 1; margin-bottom: 18px; }
h1 { margin: 0 0 14px; font-size: 32px; line-height: 1.15; }
p { margin: 0; font-size: 15px; line-height: 1.5; font-weight: 650; }
</style>
</head>
<body>
  <div class="card">
    <div class="emoji">💪</div>
    <h1>Downtime is starting</h1>
    <p>Use the main Digital Habits: Blocker warning and click <strong>Let's go!</strong> to start your wrap-up time.</p>
  </div>
</body>
</html>"#
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
    close_aux_blocking_warning_windows(app);

    let _ = w.set_max_size(None::<LogicalSize<f64>>);

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

    #[cfg(target_os = "macos")]
    ensure_macos_traffic_lights_visible(app);
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

/// Open Safari → Settings → Extensions via AppleScript. Needs
/// Accessibility permission for System Events; tries both the legacy
/// toolbar layout and the Ventura+ sidebar layout.
#[cfg(target_os = "macos")]
#[allow(dead_code)] // used on macOS; dead on Windows
pub(crate) fn open_safari_extensions_settings_applescript() -> Result<(), String> {
    const SCRIPT: &str = concat!(
        "tell application \"Safari\" to activate\n",
        "delay 0.4\n",
        "tell application \"System Events\"\n",
        "  tell process \"Safari\"\n",
        "    keystroke \",\" using command down\n",
        "    delay 1.0\n",
        "    set extClicked to false\n",
        "    try\n",
        "      click button \"Extensions\" of toolbar 1 of window 1\n",
        "      set extClicked to true\n",
        "    end try\n",
        "    if not extClicked then\n",
        "      try\n",
        "        click button \"Extensions\" of group 1 of scroll area 1 of group 1 of group 2 of splitter group 1 of group 1 of window 1\n",
        "        set extClicked to true\n",
        "      end try\n",
        "    end if\n",
        "    if not extClicked then\n",
        "      repeat with theRow in (UI elements of scroll area 1 of group 1 of group 2 of splitter group 1 of group 1 of window 1)\n",
        "        try\n",
        "          if name of theRow is \"Extensions\" then\n",
        "            click theRow\n",
        "            set extClicked to true\n",
        "            exit repeat\n",
        "          end if\n",
        "        end try\n",
        "      end repeat\n",
        "    end if\n",
        "    if not extClicked then error \"Could not open Safari Extensions settings\"\n",
        "  end tell\n",
        "end tell\n",
    );
    let out = std::process::Command::new("osascript")
        .args(["-e", SCRIPT])
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)] // used on macOS; dead on Windows
pub(crate) fn open_safari_extensions_settings_applescript() -> Result<(), String> {
    Err("Safari is macOS-only".into())
}

/// Open the browser's extension-management UI so the user can enable
/// ReDD Focus or allow it in private/incognito windows.
#[tauri::command]
pub fn open_browser_extension_settings(browser: String) -> Result<(), String> {
    let browser = browser.trim();
    let normalized = browser.to_ascii_lowercase();
    let url = match normalized.as_str() {
        "firefox" => "about:addons".to_string(),
        "edge" => format!(
            "edge://extensions/?id={}",
            crate::native_host_install::EDGE_ADDONS_EXT_ID
        ),
        "brave" => format!(
            "brave://extensions/?id={}",
            crate::native_host_install::CHROMIUM_EXT_ID
        ),
        _ => format!(
            "chrome://extensions/?id={}",
            crate::native_host_install::CHROMIUM_EXT_ID
        ),
    };

    #[cfg(target_os = "macos")]
    {
        if normalized == "safari" {
            match open_safari_extensions_settings_applescript() {
                Ok(()) => return Ok(()),
                Err(e) => {
                    log::warn!(
                        "osascript for Safari Extensions settings failed ({e}), activating Safari"
                    );
                    let _ = std::process::Command::new("/usr/bin/open")
                        .args(["-a", "Safari"])
                        .output();
                }
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

#[allow(dead_code)] // used on macOS; dead on Windows
fn is_mac_app_store_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("macappstore://")
        || lower.starts_with("itms-apps://")
        || (lower.contains("apps.apple.com") && lower.contains("/app/"))
}

/// Open a specific URL in a specific browser.  Used by the enforcer
/// "Install ReDD Focus" button so the store page opens in the correct
/// browser instead of triggering the OS "choose an app" dialog.
#[tauri::command]
pub fn open_url_in_browser(browser: String, url: String) -> Result<(), String> {
    let normalized = browser.trim().to_ascii_lowercase();

    #[cfg(target_os = "macos")]
    {
        // App Store links must use plain `open`, not `open -a Safari` — the
        // latter loads apps.apple.com in the browser instead of the store.
        if is_mac_app_store_url(&url) {
            std::process::Command::new("/usr/bin/open")
                .arg(&url)
                .output()
                .map_err(|e| format!("open App Store URL: {e}"))?;
            return Ok(());
        }

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
