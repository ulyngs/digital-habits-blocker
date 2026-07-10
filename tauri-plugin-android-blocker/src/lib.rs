use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::AndroidBlocker;
#[cfg(mobile)]
use mobile::AndroidBlocker;

/// Extension trait to access the Kotlin-backed blocking APIs from
/// [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`].
pub trait AndroidBlockerExt<R: Runtime> {
    fn android_blocker(&self) -> &AndroidBlocker<R>;
}

impl<R: Runtime, T: Manager<R>> crate::AndroidBlockerExt<R> for T {
    fn android_blocker(&self) -> &AndroidBlocker<R> {
        self.state::<AndroidBlocker<R>>().inner()
    }
}

/// Initializes the Android blocker plugin. Pure marshaling — every
/// command here forwards to the Kotlin `BlockerPlugin`, which is the
/// only place blocking logic and background work happen.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("android-blocker")
        .invoke_handler(tauri::generate_handler![
            commands::check_blocker_permissions,
            commands::open_accessibility_settings,
            commands::set_schedules,
            commands::start_manual_block,
            commands::stop_manual_block,
            commands::read_native_schedules,
            commands::get_schedule_states,
            commands::get_cached_installed_apps,
            commands::get_installed_apps,
            commands::set_event_handler,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let android_blocker = mobile::init(app, api)?;
            #[cfg(desktop)]
            let android_blocker = desktop::init(app, api)?;
            app.manage(android_blocker);
            Ok(())
        })
        .build()
}
