mod data;

#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod app_blocking;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod app_update;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod apps;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod blocking_method_cmd;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod browser_ext;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod diagnostics;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod enforcement;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod enforcement_toggle;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod grace;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod helper_shim;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod migration;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod overlay_assets;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod safari_bridge;
#[cfg(target_os = "macos")]
pub mod uninstall;
#[cfg(target_os = "macos")]
pub mod web_automation;

pub use data::*;

// `register` / `auto_start` exist in both app_blocking and web_automation (and
// enforcement). Every call site uses the qualified module path, so nothing
// depends on which glob wins — but do not start relying on the unqualified
// name without resolving this first.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[allow(ambiguous_glob_reexports)]
pub use app_blocking::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use app_update::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use apps::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use blocking_method_cmd::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use browser_ext::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use diagnostics::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[allow(ambiguous_glob_reexports)]
pub use enforcement::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use enforcement_toggle::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use grace::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use helper_shim::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use migration::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use overlay_assets::*;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use safari_bridge::*;
#[cfg(target_os = "macos")]
pub use uninstall::*;
#[cfg(target_os = "macos")]
pub use web_automation::*;
