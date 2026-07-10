#[cfg(feature = "desktop")]
use tauri::Manager;

/// Set by the tray "Quit" handler to authorise actually exiting the
/// process. Any other `ExitRequested` (Cmd-Q, Tauri's internal
/// last-window-closed signal, etc.) is intercepted and turned into a
/// hide-window — otherwise the user could accidentally kill the
/// enforcer/watcher and silently lose all blocking.
static ALLOW_EXIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Flip the macOS activation policy between Regular (Dock icon + app
/// name in the global menu bar, like a normal foreground app) and
/// Accessory (tray-only, no Dock icon, no menu bar). We switch at
/// runtime so the app behaves like Cold Turkey Blocker:
///   - window visible  → Regular  (Dock icon, menu bar present)
///   - window hidden   → Accessory (tray-only, runs in the background)
/// The enforcer keeps running regardless of the policy; this is purely
/// a UI affordance.
#[cfg(target_os = "macos")]
pub(crate) fn set_macos_activation_policy(regular: bool) {
    use cocoa::appkit::NSApplication;
    use cocoa::appkit::NSApplicationActivationPolicy::{
        NSApplicationActivationPolicyAccessory, NSApplicationActivationPolicyRegular,
    };
    let policy = if regular {
        NSApplicationActivationPolicyRegular
    } else {
        NSApplicationActivationPolicyAccessory
    };
    unsafe {
        let ns_app = cocoa::appkit::NSApp();
        let _ = ns_app.setActivationPolicy_(policy);
    }
}

#[cfg(feature = "desktop")]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

// `Menu` / `MenuItem` are only needed for the macOS app-menu extensions
// below (Help / Window items). The tray icon itself has no menu — see
// the tray builder in `setup`.
#[cfg(all(feature = "desktop", target_os = "macos"))]
use tauri::menu::{Menu, MenuItem};

#[cfg(all(feature = "desktop", target_os = "macos"))]
use tauri::menu::PredefinedMenuItem;
#[cfg(all(feature = "desktop", target_os = "macos"))]
use tauri::Emitter;

#[cfg(target_os = "macos")]
use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
#[cfg(all(feature = "desktop", target_os = "macos"))]
use std::sync::Arc;

#[cfg(target_os = "windows")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "ios")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "android")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

pub mod commands;
#[cfg(target_os = "macos")]
pub mod cross_app_consent;

/// Custom NSPanel class for the main ReDD Blocker window. Most of the time
/// this behaves indistinguishably from a regular NSWindow — but having
/// the underlying class be an NSPanel lets us toggle
/// `NSWindowStyleMaskNonactivatingPanel` (and the matching collection
/// behavior) during the app-blocking force-quit countdown so the warning
/// floats over third-party fullscreen windows without stealing focus.
/// Same shape of trick redd-do uses for its pop-out focus panel.
///
/// The `config:` block overrides NSPanel defaults so the panel acts like
/// a regular main window: it can become key + main, doesn't hide on app
/// deactivation, and isn't a floating panel by default.
//
// `tauri::Manager` is required in scope by the macro expansion (it calls
// `window.app_handle()` internally). The crate-level import is gated on
// the `desktop` feature, so re-import it here for the macOS build.
#[cfg(target_os = "macos")]
use tauri::Manager as _;

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(MainPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: true,
            becomes_key_only_if_needed: false,
            hides_on_deactivate: false,
            works_when_modal: true,
            is_floating_panel: false
        }
    })
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod app_watcher;
#[cfg(target_os = "macos")]
pub mod app_group;
#[cfg(target_os = "macos")]
pub mod window_inventory;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod enforcer;
// JOMO-style website blocking via macOS Automation (Apple Events) — the
// macOS replacement for the Safari/Chromium extension. Firefox stays on
// the extension + enforcer path.
#[cfg(target_os = "macos")]
pub mod web_automation;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod native_host;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod native_host_install;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod extension_install;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod blocking_method;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod profile_scan;
#[cfg(target_os = "macos")]
pub mod safari_services;
#[cfg(target_os = "windows")]
pub mod watchdog;
#[cfg(target_os = "windows")]
pub mod windows_login;
#[cfg(target_os = "windows")]
pub mod windows_process;

/// Add an `applicationShouldTerminate:` override on the existing
/// NSApp delegate's class that returns `NSTerminateCancel` while
/// `ALLOW_EXIT` is false. Cmd-Q routes through the AppKit terminate
/// path, which Tauri's `RunEvent::ExitRequested` does not intercept
/// in accessory mode — so we hook it at the AppKit layer ourselves.
/// The tray "Quit" handler sets `ALLOW_EXIT = true` before calling
/// `app.exit(0)`, so legitimate quits still go through.
#[cfg(target_os = "macos")]
unsafe fn install_terminate_guard(ns_app: cocoa::base::id) {
    use cocoa::base::id;
    use objc::runtime::{class_addMethod, class_getInstanceMethod, method_setImplementation, Sel};
    use objc::{msg_send, sel, sel_impl};

    extern "C" fn should_terminate(_this: id, _sel: Sel, _sender: id) -> u64 {
        // NSTerminateNow = 1, NSTerminateCancel = 0.
        if ALLOW_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
            1
        } else {
            log::info!("applicationShouldTerminate: cancelled (ALLOW_EXIT=false)");
            // Hide instead — same UX as window close.
            unsafe {
                let app = cocoa::appkit::NSApp();
                let _: () = msg_send![app, hide: app];
            }
            // Drop the Dock icon + menu bar so the app reverts to
            // tray-only background mode, matching the close-window UX.
            crate::set_macos_activation_policy(false);
            0
        }
    }

    let delegate: id = msg_send![ns_app, delegate];
    if delegate.is_null() {
        log::warn!("install_terminate_guard: NSApp has no delegate yet");
        return;
    }
    let cls: *mut objc::runtime::Class = msg_send![delegate, class];
    let sel = sel!(applicationShouldTerminate:);
    let method = class_getInstanceMethod(cls, sel) as *mut objc::runtime::Method;
    let imp = should_terminate as extern "C" fn(id, Sel, id) -> u64;
    let imp_ptr = std::mem::transmute::<_, objc::runtime::Imp>(imp);
    if method.is_null() {
        // Encoding for `NSApplicationTerminateReply (^)(id self, SEL _cmd, id sender)`.
        let types = b"Q@:@\0".as_ptr() as *const i8;
        let added = class_addMethod(cls, sel, imp_ptr, types);
        log::info!("install_terminate_guard: added applicationShouldTerminate: ({added})");
    } else {
        method_setImplementation(method, imp_ptr);
        log::info!("install_terminate_guard: replaced applicationShouldTerminate:");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows: register the AppUserModelID for this process so toast
    // notifications resolve to the bundle's Start Menu shortcut. Without
    // this, `tauri-plugin-notification` calls `CreateToastNotifier` with
    // an unregistered AUMID and Windows silently drops the toast — the
    // user sees nothing, no error is raised. Must be called before the
    // first toast and before any Win32 UI is created.
    //
    // The string MUST match `bundle.identifier` in `tauri.conf.json`,
    // which is what the NSIS installer writes into the shortcut's
    // System.AppUserModel.ID property.
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::core::PCWSTR;
        use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
        let aumid: Vec<u16> = "com.reddblock\0".encode_utf16().collect();
        if let Err(e) = SetCurrentProcessExplicitAppUserModelID(PCWSTR(aumid.as_ptr())) {
            log::warn!("SetCurrentProcessExplicitAppUserModelID failed: {e}");
        }
    }

    let builder = tauri::Builder::default();

    // Single-instance enforcement (desktop only). On Windows, the NSIS
    // post-install hook AND the finish-page "Run" checkbox can both
    // try to launch redd-block.exe right after install — without
    // single-instance we'd get two processes briefly. On macOS and
    // Windows, this also means clicking the app icon while it's
    // already running focuses the existing window instead of
    // spawning a duplicate.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init());

    // tauri-nspanel is what enables the macOS-fullscreen-overlay trick
    // for the app-blocking countdown — see `MainPanel` above and
    // `commands::set_blocking_warning_attention`.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let builder = builder.plugin(tauri_plugin_notification::init());

    // Autostart: launch at login on desktop. The "keep alive" /
    // restart-on-failure behaviour is platform-configured below once
    // the app is running (see `apply_keep_alive` in the setup block).
    // Autostart: launch at login on desktop. The "--autostart" arg
    // is appended to the LaunchAgent / Run-key entry so we can tell
    // login launches apart from user-clicked launches and start
    // hidden in the tray rather than popping the window on every
    // login. Plain double-click from Finder / Start menu doesn't
    // pass the flag, so the window shows normally there.
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--autostart"]),
    ));

    // Screen Time is iOS-only. macOS uses the browser-extension path
    // (Safari via SafariWebExtensionHandler, other browsers via the
    // same Rust native host the Windows target uses).
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_screentime::init());

    // Android blocking runs entirely in Kotlin (AccessibilityService +
    // WorkManager) — this plugin is a thin marshaling bridge only, no
    // background work on the Rust side.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_blocker::init());

    builder.setup(|app| {
            // Initialise tauri-plugin-log on EVERY build, not just
            // debug. Previously this block was gated on
            // `cfg!(debug_assertions)`, which meant release builds —
            // including the .pkg users actually install — produced no
            // log output at all. We're currently investigating the
            // macOS Sonoma+ "would like to access data from other
            // apps" TCC prompt, which only reproduces under release
            // builds installed from .pkg, so having a paper trail in
            // release is essential for that work. Once that's fixed
            // we can decide whether to lower the release verbosity
            // back down, but Info-level with file output is cheap
            // (rotated automatically) and helps any future user-
            // reported issue.
            //
            // Targets:
            //   - LogDir → ~/Library/Logs/com.reddblock/ReDD Blocker.log
            //     (macOS), %LOCALAPPDATA%\com.reddblock\logs\... (Win).
            //     `tail -F ~/Library/Logs/com.reddblock/ReDD\ Block.log`
            //     to follow live.
            //   - Stdout → useful when running `tauri dev` or from
            //     Terminal; ignored when launched from Finder.
            // Webview is intentionally NOT included as a target —
            // log records bouncing through the JS layer add noise and
            // can recurse if the frontend itself logs back into Rust.
            use tauri_plugin_log::{Target, TargetKind};
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .targets([
                        Target::new(TargetKind::LogDir { file_name: None }),
                        Target::new(TargetKind::Stdout),
                    ])
                    .build(),
            )?;
            log::info!(
                "tcc-probe: ===== ReDD Blocker launch (v{}, profile={}) =====",
                env!("CARGO_PKG_VERSION"),
                if cfg!(debug_assertions) { "debug" } else { "release" }
            );

            // Pick the initial macOS activation policy based on whether
            // the window will be shown at launch (foreground use) or
            // hidden (auto-start at login). We toggle this at runtime
            // every time the window shows / hides so the app behaves
            // like Cold Turkey Blocker:
            //   - window visible → Regular (Dock icon, menu bar)
            //   - window hidden  → Accessory (tray-only)
            // The Cmd-Q / red-X / last-window-closed paths are still
            // intercepted by `install_terminate_guard` and the
            // CloseRequested handler below, so the enforcer/watcher
            // survives every "quit" gesture and keeps running in the
            // tray.
            #[cfg(target_os = "macos")]
            unsafe {
                let is_autostart = std::env::args().any(|a| a == "--autostart");
                set_macos_activation_policy(!is_autostart);
                let ns_app = cocoa::appkit::NSApp();
                install_terminate_guard(ns_app);
            }

            // Create main window with transparent titlebar on macOS
            #[cfg(target_os = "macos")]
            {
                let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("")
                    .inner_size(1000.0, 900.0)
                    .min_inner_size(600.0, 500.0)
                    .resizable(true)
                    .center()
                    // The blocking-warning overlay runs in NonactivatingPanel
                    // mode, so dismissing it (snooze / Let's go) leaves ReDD
                    // Blocker inactive. Without first-mouse the next click on
                    // the main window only activates the app and gets
                    // swallowed — users had to click twice.
                    .accept_first_mouse(true)
                    .title_bar_style(TitleBarStyle::Overlay);

                let window = win_builder.build()?;

                // Swizzle the underlying NSWindow into our `MainPanel`
                // NSPanel subclass. This is a no-op visually — the panel
                // is configured to behave like a normal window — but it
                // unlocks `NSWindowStyleMaskNonactivatingPanel` and the
                // FullScreenAuxiliary collection behavior, which the
                // blocking-warning countdown turns on so it can float
                // over third-party fullscreen windows. Same approach as
                // redd-do's pop-out focus panel.
                use tauri_nspanel::WebviewWindowExt as _;
                if let Err(e) = window.to_panel::<MainPanel>() {
                    log::warn!("main window: to_panel failed: {e:?}");
                }

                // Set background color to match app (white)
                use cocoa::appkit::{NSColor, NSWindow};
                use cocoa::base::{id, nil};

                let ns_window = window.ns_window().unwrap() as id;
                unsafe {
                    // Pure white background
                    let bg_color = NSColor::colorWithRed_green_blue_alpha_(
                        nil,
                        1.0,  // R
                        1.0,  // G
                        1.0,  // B
                        1.0,  // A
                    );
                    ns_window.setBackgroundColor_(bg_color);
                }

                #[cfg(feature = "desktop")]
                {
                    // Extend default macOS Window menu with app zoom + reopen actions.
                    let app_menu = Menu::default(app.handle())?;
                    let help_submenu = app_menu
                        .items()?
                        .into_iter()
                        .find_map(|item| {
                            let submenu = item.as_submenu()?;
                            match submenu.text() {
                                Ok(text) if text == "Help" => Some(submenu.clone()),
                                _ => None,
                            }
                        });
                    let window_submenu = app_menu
                        .items()?
                        .into_iter()
                        .find_map(|item| {
                            let submenu = item.as_submenu()?;
                            match submenu.text() {
                                Ok(text) if text == "Window" => Some(submenu.clone()),
                                _ => None,
                            }
                        });

                    if let Some(help_submenu) = help_submenu {
                        let report_issue_item = MenuItem::with_id(
                            app,
                            "help_report_issue",
                            "Report an issue",
                            true,
                            None::<&str>,
                        )?;
                        let contact_item = MenuItem::with_id(
                            app,
                            "help_contact_us",
                            "Contact us",
                            true,
                            None::<&str>,
                        )?;
                        let who_we_are_item = MenuItem::with_id(
                            app,
                            "help_who_we_are",
                            "Who we are",
                            true,
                            None::<&str>,
                        )?;

                        help_submenu.append(&PredefinedMenuItem::separator(app)?)?;
                        help_submenu.append(&report_issue_item)?;
                        help_submenu.append(&contact_item)?;
                        help_submenu.append(&who_we_are_item)?;
                    }

                    if let Some(window_submenu) = window_submenu {
                        // Rename the native "Zoom" item to clarify behavior.
                        for item in window_submenu.items()? {
                            if let Some(predefined) = item.as_predefined_menuitem() {
                                if let Ok(text) = predefined.text() {
                                    if text == "Zoom" {
                                        let _ = predefined.set_text("Fill screen");
                                        break;
                                    }
                                }
                            }
                        }

                        let zoom_in_item = MenuItem::with_id(
                            app,
                            "window_zoom_in",
                            "Zoom In",
                            true,
                            Some("CmdOrCtrl+="),
                        )?;
                        let zoom_out_item = MenuItem::with_id(
                            app,
                            "window_zoom_out",
                            "Zoom Out",
                            true,
                            Some("CmdOrCtrl+-"),
                        )?;
                        let reopen_separator = PredefinedMenuItem::separator(app)?;
                        let reopen_item = MenuItem::with_id(
                            app,
                            "window_reopen_main",
                            "Reopen Main Window",
                            true,
                            None::<&str>,
                        )?;

                        window_submenu.append(&zoom_in_item)?;
                        window_submenu.append(&zoom_out_item)?;

                        // Keep "Reopen Main Window" only when window is minimized/hidden/closed.
                        let app_handle_for_state = app.handle().clone();
                        let window_submenu_for_state = window_submenu.clone();
                        let reopen_separator_for_state = reopen_separator.clone();
                        let reopen_item_for_state = reopen_item.clone();
                        let sync_reopen_item_visibility = Arc::new(move || {
                            let should_show_reopen = match app_handle_for_state.get_webview_window("main") {
                                Some(main_window) => {
                                    main_window.is_minimized().unwrap_or(false)
                                        || !main_window.is_visible().unwrap_or(true)
                                }
                                None => true,
                            };

                            let is_shown = window_submenu_for_state.get("window_reopen_main").is_some();
                            if should_show_reopen && !is_shown {
                                let _ = window_submenu_for_state.append(&reopen_separator_for_state);
                                let _ = window_submenu_for_state.append(&reopen_item_for_state);
                            } else if !should_show_reopen && is_shown {
                                let _ = window_submenu_for_state.remove(&reopen_item_for_state);
                                let _ = window_submenu_for_state.remove(&reopen_separator_for_state);
                            }
                        });

                        // Initial state (main window is visible at startup, so item stays hidden).
                        sync_reopen_item_visibility();

                        let sync_reopen_item_visibility_on_window = sync_reopen_item_visibility.clone();
                        window.on_window_event(move |_| {
                            sync_reopen_item_visibility_on_window();
                        });

                        let sync_reopen_item_visibility_on_menu = sync_reopen_item_visibility.clone();
                        app.on_menu_event(move |app, event| {
                            sync_reopen_item_visibility_on_menu();

                            match event.id().as_ref() {
                                "window_zoom_in" => {
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("menu-zoom-in", ());
                                    }
                                }
                                "window_zoom_out" => {
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("menu-zoom-out", ());
                                    }
                                }
                                "window_reopen_main" => {
                                    if app.get_webview_window("main").is_some() {
                                        // `reveal_app` flips activation
                                        // policy back to Regular and
                                        // brings the window forward.
                                        commands::reveal_app(app);
                                    } else {
                                        // Recreate main window if it was fully closed.
                                        let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                                            .title("")
                                            .inner_size(1000.0, 900.0)
                                            .min_inner_size(600.0, 500.0)
                                            .resizable(true)
                                            .center()
                                            // Keep in sync with the initial build above
                                            // (single-click response after panel-mode dismissal).
                                            .accept_first_mouse(true)
                                            .title_bar_style(TitleBarStyle::Overlay);

                                        if let Ok(new_window) = win_builder.build() {
                                            // Re-apply NSPanel swizzle on the rebuilt
                                            // window so the blocking-warning fullscreen
                                            // overlay still works after a close+reopen.
                                            use tauri_nspanel::WebviewWindowExt as _;
                                            if let Err(e) = new_window.to_panel::<MainPanel>() {
                                                log::warn!("main window (rebuild): to_panel failed: {e:?}");
                                            }

                                            use cocoa::appkit::{NSColor, NSWindow};
                                            use cocoa::base::{id, nil};

                                            let ns_window = new_window.ns_window().unwrap() as id;
                                            unsafe {
                                                let bg_color = NSColor::colorWithRed_green_blue_alpha_(
                                                    nil, 1.0, 1.0, 1.0, 1.0,
                                                );
                                                ns_window.setBackgroundColor_(bg_color);
                                            }
                                            set_macos_activation_policy(true);
                                            let _ = new_window.show();
                                            let _ = new_window.set_focus();
                                        }
                                    }
                                    sync_reopen_item_visibility_on_menu();
                                }
                                "help_report_issue" => {
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("menu-help-report-issue", ());
                                    }
                                }
                                "help_contact_us" => {
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("menu-help-contact-us", ());
                                    }
                                }
                                "help_who_we_are" => {
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.emit("menu-help-who-we-are", ());
                                    }
                                }
                                _ => {}
                            }
                        });
                    }
                    app_menu.set_as_app_menu()?;
                }
            }

            // Create main window on Windows
            #[cfg(target_os = "windows")]
            {
                let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("ReDD Blocker")
                    .inner_size(840.0, 750.0)
                    .min_inner_size(600.0, 500.0)
                    .resizable(true)
                    .decorations(false) // Hide native title bar, use custom controls
                    .icon(tauri::include_image!("icons/128x128.png"))?
                    .center();

                win_builder.build()?;
            }

            // Create main window on iOS — full screen webview
            #[cfg(target_os = "ios")]
            {
                let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .build()?;
            }

            // Create main window on Android — full screen webview
            #[cfg(target_os = "android")]
            {
                let _window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .build()?;
            }

            // Tray icon (desktop only) — no right-click menu by design:
            // exiting the app would tear down the enforcer/watcher and
            // silently drop active blocks. Left-click reveals/focuses
            // the main window; right-click does nothing. The only way
            // out is uninstall.
            #[cfg(feature = "desktop")]
            {
                // macOS template convention: black + alpha, system tints it.
                // `include_image!` decodes the PNG at compile time.
                let _tray = TrayIconBuilder::new()
                    .icon(tauri::include_image!("icons/tray-template.png"))
                    .icon_as_template(true)
                    .tooltip("ReDD Blocker")
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            // `reveal_app` flips the activation policy
                            // back to Regular (Dock icon + menu bar)
                            // and pulls the app to the foreground —
                            // required because we run as Accessory
                            // while the window is hidden.
                            commands::reveal_app(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            // Register app-watcher + enforcer state handles, and
            // auto-start the enforcer. The enforcer scans browsers
            // for missing/disabled extensions every 5 s and quits the
            // browser if the user doesn't fix it within the grace
            // window — that's the whole point of the migration, so
            // there's no reason to gate it behind a frontend opt-in.
            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                commands::app_blocking::register(app);
                commands::enforcement::register(app);
                commands::enforcement::auto_start(app.handle());
            }

            // macOS website blocking runs through Automation (Apple
            // Events), not the extension, for Safari + Chromium. Register
            // its state handle and auto-start the watcher (paused until
            // onboarding completes — same gate as the enforcer).
            #[cfg(target_os = "macos")]
            {
                commands::web_automation::register(app);
                commands::web_automation::auto_start(app.handle());
                if let Some(path) = commands::canonical_data_path(app.handle()) {
                    crate::app_group::ensure_sync_loop(path.clone());
                    // Manifest checks touch browser-owned directories and do
                    // not affect the first webview frame. Keep them out of
                    // Tauri's setup callback so the event loop can begin
                    // painting as soon as the window has been created.
                    std::thread::spawn(move || {
                        if let Err(e) =
                            native_host_install::sync_extension_mode_native_hosts(&path, false)
                        {
                            log::warn!(
                                "native-host sync for extension-mode browsers failed: {e}"
                            );
                        }
                        if crate::cross_app_consent::should_run_profile_scans() {
                            if let Err(e) = native_host_install::sync_firefox_native_host(false) {
                                log::warn!("native-host sync for firefox failed: {e}");
                            }
                        }
                    });
                }
            }

            // Ensure notification permission is granted (or prompt for
            // it once). Without this, the enforcer's grace / kill
            // notifications silently no-op. macOS prompts via
            // NSUserNotificationCenter; Windows toasts don't need a
            // runtime prompt and the call returns Granted immediately.
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                use tauri_plugin_notification::NotificationExt;
                let n = app.notification();
                log::info!("tcc-probe: about to check notification permission_state");
                log::info!("tcc-probe: notification permission_state: {:?}", n.permission_state());
                log::info!("tcc-probe: about to call notification request_permission");
                match n.request_permission() {
                    Ok(state) => log::info!("tcc-probe: notification request_permission -> {state:?}"),
                    Err(e) => log::warn!("tcc-probe: notification request_permission failed: {e}"),
                }
            }

            // On macOS, Safari/Chromium use Automation; Firefox extension
            // is installed manually — Firefox native-host manifest sync
            // runs above (EULA-gated) and during onboarding scans.
            #[cfg(all(not(any(target_os = "ios", target_os = "android")), not(target_os = "macos")))]
            if let Err(e) = native_host_install::install() {
                log::warn!("native-host install on startup failed: {e}");
            }

            #[cfg(all(not(any(target_os = "ios", target_os = "android")), not(target_os = "macos")))]
            if !extension_install::startup_install_already_done() {
                if let Err(e) = extension_install::install() {
                    log::warn!("extension-install hint on startup failed: {e}");
                } else {
                    extension_install::mark_startup_install_done();
                }
            } else {
                log::debug!(
                    "extension-install: startup auto-install skipped (marker present)"
                );
            }

            // Self-heal the watchdog Scheduled Task on Windows. If the
            // user disabled or deleted it (or the install dir moved),
            // this rewrites the wrapper script with the current exe
            // path and re-registers the task. Idempotent.
            //
            // Gated on release builds only — in `tauri dev` the
            // watchdog would respawn the debug binary, lock the build
            // artifact, and interfere with `cargo` rebuilds.
            #[cfg(all(target_os = "windows", not(debug_assertions)))]
            watchdog::register();

            // Self-heal launch-at-login on every startup. For ReDD
            // Block 2.0 the app IS the enforcement engine, so blocking
            // dies if the user reboots and we don't come back. We
            // therefore (re)register on every release-build launch.
            //
            // Calling `enable()` unconditionally — instead of only
            // when `is_enabled()` is false — is deliberate: it makes
            // the most-recently-launched release build win the slot.
            // This rewrites the LaunchAgent / Run-key so that:
            //   - reinstalling .pkg into a different location heals
            //     the registered path,
            //   - moving the .app within /Applications heals on next
            //     launch,
            //   - a slot orphaned by an uninstall + reinstall cycle
            //     gets reclaimed,
            //   - and a slot previously hijacked by some other binary
            //     (e.g. an earlier dev-build run, before the
            //     debug_assertions gate below was added) gets
            //     reclaimed too.
            // The write itself is a few hundred bytes to a plist /
            // registry value; idempotent when the path is unchanged.
            //
            // Gated on `not(debug_assertions)` so `tauri dev` runs do
            // NOT register the dev binary as the launch-at-login
            // target. The dev binary depends on a Vite dev server
            // that's only running while `tauri dev` is in the
            // foreground; if it ever fires from launchd at login the
            // user gets a blank window pointing at
            // http://localhost:5173. Release builds — the .pkg / .dmg
            // path users actually install — keep self-healing.
            #[cfg(all(not(any(target_os = "ios", target_os = "android")), not(debug_assertions)))]
            {
                use tauri_plugin_autostart::ManagerExt;
                #[cfg(target_os = "macos")]
                crate::commands::uninstall::scrub_stale_autostart_plists();
                log::info!("tcc-probe: about to call autolaunch().enable() (LaunchAgent plist write)");
                if let Err(e) = app.autolaunch().enable() {
                    log::warn!("autostart enable failed: {e}");
                } else {
                    log::info!(
                        "tcc-probe: autolaunch().enable() returned ok; exe={:?}",
                        std::env::current_exe().ok()
                    );
                }
            }

            // Hide-on-close for the main window. The app is the
            // enforcement engine now (no privileged helper), so
            // closing it would stop schedules from firing. Intercept
            // the close request and hide to tray instead. On macOS we
            // also flip the activation policy back to Accessory so the
            // Dock icon disappears — matching Cold Turkey Blocker's
            // behaviour of "open = foreground app, closed = tray-only".
            #[cfg(feature = "desktop")]
            if let Some(main) = app.get_webview_window("main") {
                let win_for_event = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_for_event.hide();
                        #[cfg(target_os = "macos")]
                        set_macos_activation_policy(false);
                    }
                });

                // Start hidden when launched by the LaunchAgent /
                // Run-key entry — tauri-plugin-autostart appends the
                // "--autostart" arg above. Without this, every login
                // would briefly pop the window in the user's face.
                // The user can re-open the window via the tray icon.
                #[cfg(not(any(target_os = "ios", target_os = "android")))]
                if std::env::args().any(|a| a == "--autostart") {
                    let _ = main.hide();
                    log::info!("startup: launched by autostart, window hidden");
                }
            }

            Ok(())
        })
        .invoke_handler(all_commands())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Belt + braces: also catch any `ExitRequested` Tauri may
            // emit (last-window-closed paths, etc.). Cmd-Q is handled
            // by the AppKit `applicationShouldTerminate:` hook in
            // `install_terminate_guard`.
            // Match by reference so multiple `if let` arms can read the
            // same event without moving non-`Copy` payloads (e.g.
            // `ExitRequestApi`) out of it.
            #[cfg(feature = "desktop")]
            if let tauri::RunEvent::ExitRequested { api, .. } = &_event {
                if !ALLOW_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }

            // Dock-icon click while the window is hidden: surface the
            // window again. Without this, switching the activation
            // policy to Regular puts a Dock icon in the user's Dock
            // that does nothing on click.
            #[cfg(all(feature = "desktop", target_os = "macos"))]
            if let tauri::RunEvent::Reopen { .. } = &_event {
                commands::reveal_app(_app);
            }
        });
}

/// All commands for macOS.
#[cfg(target_os = "macos")]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        commands::get_app_version,
        commands::is_microsoft_store_package,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
        commands::open_app_picker,
        commands::list_installed_apps,
        commands::set_blocked_apps,
        commands::clear_blocked_apps,
        commands::app_blocking_bring_forward_then_quit_again,
        commands::lets_go_acknowledge,
        commands::snooze_blocking_warning,
        commands::reshow_blocking_warning,
        commands::reconcile_blocking_warning_shell,
        commands::resize_blocking_warning_inner_size,
        commands::enter_blocking_warning_panel_mode,
        commands::leave_blocking_warning_panel_mode,
        commands::scan_browser_profiles,
        commands::is_firefox_installed,
        commands::browser_profiles_compliant,
        commands::activate_app,
        commands::hide_main_window,
        native_host_install::install_native_host,
        native_host_install::ensure_firefox_native_host,
        native_host_install::uninstall_native_host,
        extension_install::install_extension_hints,
        extension_install::uninstall_extension_hints,
        commands::enforcer_start,
        commands::enforcer_pause,
        commands::web_automation_start,
        commands::web_automation_pause,
        commands::web_automation_permission_status,
        commands::request_automation_permission,
        commands::open_automation_settings,
        commands::strip_hosts_markers,
        commands::uninstall_legacy_helper,
        commands::run_upgrade_migration,
        commands::migration_pending,
        commands::migration_was_pending_at_launch,
        commands::user_came_from_v1x,
        commands::get_extension_grace_seconds,
        commands::set_extension_grace_seconds,
        commands::get_enforcement_enabled,
        commands::set_enforcement_enabled,
        commands::get_blocking_methods,
        commands::set_blocking_method,
        commands::get_system_diagnostics,
        commands::onboarding_state,
        commands::check_helper_status,
        commands::install_helper,
        commands::uninstall_helper,
        commands::start_block_via_helper,
        commands::clear_block_via_helper,
        commands::set_blocked_apps_via_helper,
        commands::set_blocks_via_helper,
        commands::set_schedules_via_helper,
        commands::block_websites,
        commands::clean_hosts_file,
        commands::get_helper_diagnostics,
        commands::check_safari_fda_access,
        commands::sync_safari_fda_access,
        commands::complete_safari_fda_onboarding,
        commands::open_safari_fda_settings,
        commands::open_safari_extension_settings,
        commands::open_browser_extension_settings,
        commands::open_url_in_browser,
        commands::save_overlay_image_asset,
        commands::save_overlay_image_asset_bytes,
        commands::save_overlay_voice_asset,
        commands::resolve_overlay_asset_path,
        commands::read_overlay_source_bytes,
        commands::delete_overlay_asset,
        commands::uninstall_self_macos,
        commands::download_and_run_update,
    ]
}

/// All commands for Windows / Linux desktop.
#[cfg(not(any(target_os = "ios", target_os = "android", target_os = "macos")))]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        commands::get_app_version,
        commands::is_microsoft_store_package,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
        commands::open_app_picker,
        commands::list_installed_apps,
        commands::set_blocked_apps,
        commands::clear_blocked_apps,
        commands::app_blocking_bring_forward_then_quit_again,
        commands::lets_go_acknowledge,
        commands::snooze_blocking_warning,
        commands::reshow_blocking_warning,
        commands::reconcile_blocking_warning_shell,
        commands::resize_blocking_warning_inner_size,
        commands::enter_blocking_warning_panel_mode,
        commands::leave_blocking_warning_panel_mode,
        commands::scan_browser_profiles,
        commands::is_firefox_installed,
        commands::browser_profiles_compliant,
        commands::activate_app,
        commands::hide_main_window,
        native_host_install::install_native_host,
        native_host_install::ensure_firefox_native_host,
        native_host_install::uninstall_native_host,
        extension_install::install_extension_hints,
        extension_install::uninstall_extension_hints,
        commands::enforcer_start,
        commands::enforcer_pause,
        commands::strip_hosts_markers,
        commands::uninstall_legacy_helper,
        commands::run_upgrade_migration,
        commands::migration_pending,
        commands::migration_was_pending_at_launch,
        commands::user_came_from_v1x,
        commands::get_extension_grace_seconds,
        commands::set_extension_grace_seconds,
        commands::get_enforcement_enabled,
        commands::set_enforcement_enabled,
        commands::get_system_diagnostics,
        commands::onboarding_state,
        commands::check_helper_status,
        commands::install_helper,
        commands::uninstall_helper,
        commands::start_block_via_helper,
        commands::clear_block_via_helper,
        commands::set_blocked_apps_via_helper,
        commands::set_blocks_via_helper,
        commands::set_schedules_via_helper,
        commands::block_websites,
        commands::clean_hosts_file,
        commands::get_helper_diagnostics,
        commands::open_browser_extension_settings,
        commands::open_url_in_browser,
        commands::save_overlay_image_asset,
        commands::save_overlay_image_asset_bytes,
        commands::save_overlay_voice_asset,
        commands::resolve_overlay_asset_path,
        commands::read_overlay_source_bytes,
        commands::delete_overlay_asset,
        commands::download_and_run_update,
    ]
}

/// Commands for mobile (iOS). Only the shared data
/// commands — platform blocking goes through the Screen Time /
/// screentime plugin, which registers its own commands.
#[cfg(target_os = "ios")]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        // Data commands (all platforms)
        commands::get_app_version,
        commands::is_microsoft_store_package,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
    ]
}

/// Commands for Android (only shared commands for now; android-blocker plugin adds the rest)
#[cfg(target_os = "android")]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        // Data commands (all platforms)
        commands::get_app_version,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
    ]
}
