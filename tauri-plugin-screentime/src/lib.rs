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
use desktop::Screentime;
#[cfg(mobile)]
use mobile::Screentime;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the Screen Time APIs.
pub trait ScreentimeExt<R: Runtime> {
    fn screentime(&self) -> &Screentime<R>;
}

impl<R: Runtime, T: Manager<R>> crate::ScreentimeExt<R> for T {
    fn screentime(&self) -> &Screentime<R> {
        self.state::<Screentime<R>>().inner()
    }
}

/// Initializes the Screen Time plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screentime")
        .invoke_handler(tauri::generate_handler![
            commands::request_authorization,
            commands::check_authorization,
            commands::block_websites,
            commands::unblock_websites,
            commands::block_apps,
            commands::unblock_apps,
            commands::refresh_activity_tokens,
            commands::screentime_start_block,
            commands::screentime_clear_block,
            commands::schedule_block,
            commands::set_schedules,
            commands::unschedule_block,
            commands::register_one_off_activity,
            commands::set_resume_payload,
            commands::set_block_end_state,
            commands::show_activity_picker,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let screentime = mobile::init(app, api)?;
            #[cfg(desktop)]
            let screentime = desktop::init(app, api)?;
            app.manage(screentime);
            Ok(())
        })
        .build()
}
