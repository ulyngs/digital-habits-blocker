#[cfg(feature = "desktop")]
use tauri::Manager;

#[cfg(feature = "desktop")]
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

#[cfg(all(feature = "desktop", target_os = "macos"))]
use tauri::menu::PredefinedMenuItem;
#[cfg(all(feature = "desktop", target_os = "macos"))]
use tauri::Emitter;

#[cfg(target_os = "macos")]
use tauri::{TitleBarStyle, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use std::sync::Arc;

#[cfg(target_os = "windows")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "ios")]
use tauri::{WebviewUrl, WebviewWindowBuilder};

mod commands;

#[cfg(not(target_os = "ios"))]
pub mod blocklist;
#[cfg(not(target_os = "ios"))]
pub mod native_host;

/// Returns true iff the process was launched with the `--native-host` CLI
/// flag. Checked by `main()` before any Tauri initialization so we can
/// cleanly branch into the native messaging loop without bringing up a
/// window / tray icon / etc.
#[cfg(not(target_os = "ios"))]
pub fn is_native_host_invocation() -> bool {
    std::env::args().any(|a| a == "--native-host")
}

#[cfg(target_os = "ios")]
pub fn is_native_host_invocation() -> bool {
    false
}

/// Delegate to the native-host event loop. Only called when the CLI flag is
/// present. The browser holds the stdio pipes; we never return `Ok(())`
/// cleanly (exit code matters: Chrome treats non-zero as "host crashed").
#[cfg(not(target_os = "ios"))]
pub fn run_native_host() -> std::io::Result<()> {
    native_host::run()
}

#[cfg(target_os = "ios")]
pub fn run_native_host() -> std::io::Result<()> {
    Err(std::io::Error::other("native host unsupported on iOS"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        // Desktop-only: system notifications used by the extension
        // enforcer so a browser-level problem is visible even when the
        // ReDD Block window is hidden behind Chrome / Firefox.
        .plugin(tauri_plugin_notification::init());

    // On iOS, also register the Screen Time plugin
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

            // Create system tray menu (desktop only)
            #[cfg(feature = "desktop")]
            {
                let open_item = MenuItem::with_id(app, "open", "Open ReDD Block", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

                // Build tray icon
                let _tray = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("ReDD Block")
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "open" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .invoke_handler(all_commands())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// All commands for desktop platforms (includes helper, apps, extension)
#[cfg(not(target_os = "ios"))]
fn all_commands() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        // Data commands (all platforms)
        commands::get_app_version,
        commands::load_data,
        commands::save_data,
        commands::set_window_size,
        // App commands (desktop only)
        commands::open_app_picker,
        commands::get_running_apps,
        commands::minimize_app,
        // Helper commands (desktop only — app blocking)
        commands::check_helper_status,
        commands::install_helper,
        commands::uninstall_helper,
        commands::start_block_via_helper,
        commands::clear_block_via_helper,
        commands::set_blocked_apps_via_helper,
        commands::set_blocks_via_helper,
        commands::set_schedules_via_helper,
        commands::set_keep_blocking_on_uninstall_via_helper,
        commands::block_websites,
        commands::clean_hosts_file,
        commands::get_helper_diagnostics,
        // Browser-extension commands (website blocking)
        commands::install_browser_extension_manifests,
        commands::uninstall_browser_extension_manifests,
        commands::install_browser_extension_force_install_policies,
        commands::uninstall_browser_extension_force_install_policies,
        commands::check_extension_status,
        commands::get_native_host_blocklist_preview,
        commands::start_extension_enforcement,
        commands::stop_extension_enforcement,
        commands::is_extension_enforcement_running,
        commands::open_browser_extensions_page,
        commands::focus_main_window,
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
