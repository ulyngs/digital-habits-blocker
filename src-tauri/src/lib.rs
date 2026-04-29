#[cfg(feature = "desktop")]
use tauri::Manager;

/// Set by the tray "Quit" handler to authorise actually exiting the
/// process. Any other `ExitRequested` (Cmd-Q, Tauri's internal
/// last-window-closed signal, etc.) is intercepted and turned into a
/// hide-window — otherwise the user could accidentally kill the
/// enforcer/watcher and silently lose all blocking.
static ALLOW_EXIT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

pub mod commands;

#[cfg(not(target_os = "ios"))]
pub mod app_watcher;
#[cfg(target_os = "macos")]
pub mod app_group;
#[cfg(not(target_os = "ios"))]
pub mod enforcer;
#[cfg(not(target_os = "ios"))]
pub mod native_host;
#[cfg(not(target_os = "ios"))]
pub mod native_host_install;
#[cfg(not(target_os = "ios"))]
pub mod profile_scan;
#[cfg(target_os = "windows")]
pub mod watchdog;

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
    #[cfg(not(target_os = "ios"))]
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
    #[cfg(not(target_os = "ios"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--autostart"]),
    ));

    // Screen Time is iOS-only. macOS uses the browser-extension path
    // (Safari via SafariWebExtensionHandler, other browsers via the
    // same Rust native host the Windows target uses).
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_screentime::init());

    builder.setup(|app| {
            // Set up logging in debug mode
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Run as a menu-bar accessory app on macOS: no dock icon,
            // no app-menu Cmd-Q in the global menu when no window is
            // focused. The window is still openable via the tray.
            // This is the standard pattern for background utilities
            // that occasionally surface a UI (Bartender, Hidden Bar,
            // etc.). Combined with the ExitRequested interceptor, it
            // prevents users from accidentally tearing down the
            // enforcer/watcher.
            #[cfg(target_os = "macos")]
            unsafe {
                use cocoa::appkit::{
                    NSApplication, NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
                };
                let ns_app = cocoa::appkit::NSApp();
                let _ = ns_app.setActivationPolicy_(NSApplicationActivationPolicyAccessory);
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
                    .title_bar_style(TitleBarStyle::Overlay);

                let window = win_builder.build()?;

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
                                    if let Some(window) = app.get_webview_window("main") {
                                        let _ = window.unminimize();
                                        let _ = window.show();
                                        let _ = window.set_focus();
                                    } else {
                                        // Recreate main window if it was fully closed.
                                        let win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                                            .title("")
                                            .inner_size(1000.0, 900.0)
                                            .min_inner_size(600.0, 500.0)
                                            .resizable(true)
                                            .center()
                                            .title_bar_style(TitleBarStyle::Overlay);

                                        if let Ok(new_window) = win_builder.build() {
                                            use cocoa::appkit::{NSColor, NSWindow};
                                            use cocoa::base::{id, nil};

                                            let ns_window = new_window.ns_window().unwrap() as id;
                                            unsafe {
                                                let bg_color = NSColor::colorWithRed_green_blue_alpha_(
                                                    nil, 1.0, 1.0, 1.0, 1.0,
                                                );
                                                ns_window.setBackgroundColor_(bg_color);
                                            }
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
                    .title("ReDD Block")
                    .inner_size(840.0, 750.0)
                    .min_inner_size(600.0, 500.0)
                    .resizable(true)
                    .decorations(false) // Hide native title bar, use custom controls
                    .center();

                win_builder.build()?;
            }

            // Create main window on iOS — full screen webview
            #[cfg(target_os = "ios")]
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
                    .tooltip("ReDD Block")
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
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
            #[cfg(not(target_os = "ios"))]
            {
                commands::app_blocking::register(app);
                commands::enforcement::register(app);
                commands::enforcement::auto_start(app.handle());
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
                log::info!("notification permission_state: {:?}", n.permission_state());
                match n.request_permission() {
                    Ok(state) => log::info!("notification request_permission -> {state:?}"),
                    Err(e) => log::warn!("notification request_permission failed: {e}"),
                }
            }

            // Refresh per-browser native-messaging manifests on every
            // launch. Idempotent — overwrites the JSON with the current
            // exe path so a dragged or reinstalled app still resolves.
            #[cfg(not(target_os = "ios"))]
            if let Err(e) = native_host_install::install() {
                log::warn!("native-host install on startup failed: {e}");
            }

            #[cfg(target_os = "macos")]
            if let Some(data_path) = native_host::resolve_data_path() {
                app_group::start_sync_loop(data_path);
            }

            // Self-heal the watchdog Scheduled Task on Windows. If the
            // user disabled or deleted it (or the install dir moved),
            // this rewrites the wrapper script with the current exe
            // path and re-registers the task. Idempotent.
            #[cfg(target_os = "windows")]
            watchdog::register();

            // Self-heal launch-at-login on every startup. The
            // tauri-plugin-autostart plugin only installs the
            // facility — it doesn't enable the entry by default.
            // For ReDD Block 2.0 the app IS the enforcement engine,
            // so blocking dies if the user reboots and we don't come
            // back. Enabling on every launch is idempotent (no-op if
            // already registered) and self-heals if the user later
            // removes us from Login Items.
            #[cfg(not(target_os = "ios"))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                let already = manager.is_enabled().unwrap_or(false);
                if !already {
                    if let Err(e) = manager.enable() {
                        log::warn!("autostart enable failed: {e}");
                    } else {
                        log::info!("autostart: enabled launch-at-login");
                    }
                }
            }

            // Hide-on-close for the main window. The app is the
            // enforcement engine now (no privileged helper), so
            // closing it would stop schedules from firing. Intercept
            // the close request and hide to tray instead.
            #[cfg(feature = "desktop")]
            if let Some(main) = app.get_webview_window("main") {
                let win_for_event = main.clone();
                main.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_for_event.hide();
                    }
                });

                // Start hidden when launched by the LaunchAgent /
                // Run-key entry — tauri-plugin-autostart appends the
                // "--autostart" arg above. Without this, every login
                // would briefly pop the window in the user's face.
                // The user can re-open the window via the tray icon.
                #[cfg(not(target_os = "ios"))]
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
            #[cfg(feature = "desktop")]
            if let tauri::RunEvent::ExitRequested { api, .. } = _event {
                if !ALLOW_EXIT.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        });
}

/// All commands for macOS.
#[cfg(target_os = "macos")]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        commands::get_app_version,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
        commands::open_app_picker,
        commands::set_blocked_apps,
        commands::clear_blocked_apps,
        commands::scan_browser_profiles,
        commands::browser_profiles_compliant,
        commands::open_browser_extension_settings,
        commands::activate_app,
        native_host_install::install_native_host,
        native_host_install::uninstall_native_host,
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
        commands::open_safari_fda_settings,
    ]
}

/// All commands for Windows / Linux desktop.
#[cfg(all(not(target_os = "ios"), not(target_os = "macos")))]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        commands::get_app_version,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
        commands::open_app_picker,
        commands::set_blocked_apps,
        commands::clear_blocked_apps,
        commands::scan_browser_profiles,
        commands::browser_profiles_compliant,
        commands::open_browser_extension_settings,
        commands::activate_app,
        native_host_install::install_native_host,
        native_host_install::uninstall_native_host,
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
    ]
}

/// Commands for iOS (only shared commands for now; Screen Time plugin will add more)
#[cfg(target_os = "ios")]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        // Data commands (all platforms)
        commands::get_app_version,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
    ]
}
