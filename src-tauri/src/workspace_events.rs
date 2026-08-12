//! NSWorkspace notification bridge (macOS).
//!
//! Turns AppKit's workspace notifications into cheap process-wide state
//! the enforcement loops can consume without polling:
//!
//!   - `didLaunchApplication` / `didActivateApplication` → wake every
//!     registered watcher condvar, so the app watcher can sit on a slow
//!     safety-net cadence and still react to a blocked-app launch (or an
//!     allowlist frontmost change) within milliseconds.
//!   - `didActivateApplication` also records the frontmost app's bundle
//!     id, which the Automation watcher uses to script the browser the
//!     user is actually looking at every tick while backing background
//!     browsers off to a slower cadence.
//!   - `screensDidSleep` / `screensDidWake` → a flag the Automation
//!     watcher checks to stop scripting browsers while the display is
//!     off (nobody can see a blocked tab; the restore/redirect happens
//!     on the first tick after wake).
//!
//! `install()` must run on the main thread (Tauri's `setup` closure) —
//! NSWorkspace posts these notifications on the main run loop, which the
//! Tauri process always pumps. The observer object is intentionally
//! leaked; it lives for the process lifetime.
//!
//! If `install()` is never called (tests, or a future caller ordering
//! bug) `events_active()` stays false and every consumer falls back to
//! its legacy polling cadence — event delivery is a power optimization,
//! never a correctness dependency.

#![allow(deprecated)]
// The macOS FFI in this module goes through the `cocoa` crate, whose entire
// surface is deprecated in favour of `objc2`. That migration is real work and
// unrelated to what this module does; scoping the allow here keeps the
// `-D warnings` clippy gate meaningful for every other lint.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use cocoa::base::{id, nil};
use cocoa::foundation::NSString;
use objc::declare::ClassDecl;
use objc::runtime::{Object, Sel};
use objc::{class, msg_send, sel, sel_impl};

/// Shared wake handle: flag + condvar. A watcher sleeps with
/// `wait_timeout` on the condvar; `wake_all` sets the flag and notifies,
/// so a wake that races the watcher's sweep is never lost.
pub type WakePair = (Mutex<bool>, Condvar);

static INSTALLED: AtomicBool = AtomicBool::new(false);
static EVENTS_ACTIVE: AtomicBool = AtomicBool::new(false);
static SCREEN_ASLEEP: AtomicBool = AtomicBool::new(false);

static FRONTMOST_BUNDLE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static WAKERS: OnceLock<Mutex<Vec<Arc<WakePair>>>> = OnceLock::new();

fn frontmost_bundle() -> &'static Mutex<Option<String>> {
    FRONTMOST_BUNDLE.get_or_init(|| Mutex::new(None))
}

fn wakers() -> &'static Mutex<Vec<Arc<WakePair>>> {
    WAKERS.get_or_init(|| Mutex::new(Vec::new()))
}

/// True once `install()` has successfully registered the observers.
pub fn events_active() -> bool {
    EVENTS_ACTIVE.load(Ordering::SeqCst)
}

/// True while the displays are asleep (per NSWorkspace screen
/// notifications). False when events aren't installed.
pub fn screen_asleep() -> bool {
    SCREEN_ASLEEP.load(Ordering::SeqCst)
}

/// Bundle id of the frontmost application, as of the last activation
/// notification (seeded once at install). `None` when unknown — callers
/// must treat unknown as "poll everything", never as "poll nothing".
pub fn frontmost_bundle_id() -> Option<String> {
    frontmost_bundle().lock().ok().and_then(|g| g.clone())
}

/// Register a watcher's wake handle. Every app launch/activation and
/// screen wake sets the flag and notifies the condvar.
pub fn add_waker(w: Arc<WakePair>) {
    if let Ok(mut g) = wakers().lock() {
        g.push(w);
    }
}

pub fn wake_all() {
    let Ok(g) = wakers().lock() else {
        return;
    };
    for w in g.iter() {
        let (flag, cvar) = &**w;
        if let Ok(mut f) = flag.lock() {
            *f = true;
        }
        cvar.notify_all();
    }
}

fn set_frontmost_from_notification(notif: id) {
    unsafe {
        let user_info: id = msg_send![notif, userInfo];
        if user_info.is_null() {
            return;
        }
        let key = NSString::alloc(nil).init_str("NSWorkspaceApplicationKey");
        let app_obj: id = msg_send![user_info, objectForKey: key];
        let _: () = msg_send![key, release];
        if app_obj.is_null() {
            return;
        }
        let bundle = nsstring_property(app_obj, sel!(bundleIdentifier));
        if let Ok(mut g) = frontmost_bundle().lock() {
            *g = bundle;
        }
    }
}

unsafe fn nsstring_property(obj: id, selector: Sel) -> Option<String> {
    let s: id = msg_send![obj, performSelector: selector];
    if s.is_null() {
        return None;
    }
    let c: *const std::os::raw::c_char = msg_send![s, UTF8String];
    if c.is_null() {
        return None;
    }
    Some(std::ffi::CStr::from_ptr(c).to_string_lossy().into_owned())
}

extern "C" fn app_launched(_this: &Object, _sel: Sel, _notif: id) {
    wake_all();
}

extern "C" fn app_activated(_this: &Object, _sel: Sel, notif: id) {
    set_frontmost_from_notification(notif);
    wake_all();
}

extern "C" fn screens_slept(_this: &Object, _sel: Sel, _notif: id) {
    SCREEN_ASLEEP.store(true, Ordering::SeqCst);
}

extern "C" fn screens_woke(_this: &Object, _sel: Sel, _notif: id) {
    SCREEN_ASLEEP.store(false, Ordering::SeqCst);
    wake_all();
}

/// Register the NSWorkspace observers. Idempotent; main thread only.
pub fn install() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(mut decl) = ClassDecl::new("ReddWorkspaceObserver", class!(NSObject)) else {
        log::warn!("workspace_events: observer class already registered; events disabled");
        return;
    };
    unsafe {
        decl.add_method(
            sel!(reddAppLaunched:),
            app_launched as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(reddAppActivated:),
            app_activated as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(reddScreensSlept:),
            screens_slept as extern "C" fn(&Object, Sel, id),
        );
        decl.add_method(
            sel!(reddScreensWoke:),
            screens_woke as extern "C" fn(&Object, Sel, id),
        );
        let cls = decl.register();
        // Leaked deliberately: observers must outlive the run loop.
        let observer: id = msg_send![cls, new];
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let nc: id = msg_send![ws, notificationCenter];

        unsafe fn observe(nc: id, observer: id, selector: Sel, name: &str) {
            let name_ns = NSString::alloc(nil).init_str(name);
            let _: () = msg_send![nc, addObserver:observer
                                        selector:selector
                                            name:name_ns
                                          object:nil];
            // `name_ns` is retained by the notification center registration
            // path as needed; release our +1.
            let _: () = msg_send![name_ns, release];
        }

        observe(
            nc,
            observer,
            sel!(reddAppLaunched:),
            "NSWorkspaceDidLaunchApplicationNotification",
        );
        observe(
            nc,
            observer,
            sel!(reddAppActivated:),
            "NSWorkspaceDidActivateApplicationNotification",
        );
        observe(
            nc,
            observer,
            sel!(reddScreensSlept:),
            "NSWorkspaceScreensDidSleepNotification",
        );
        observe(
            nc,
            observer,
            sel!(reddScreensWoke:),
            "NSWorkspaceScreensDidWakeNotification",
        );

        // Seed the frontmost app so the Automation watcher has a correct
        // answer before the first activation notification arrives.
        let front: id = msg_send![ws, frontmostApplication];
        if !front.is_null() {
            let bundle = nsstring_property(front, sel!(bundleIdentifier));
            if let Ok(mut g) = frontmost_bundle().lock() {
                *g = bundle;
            }
        }
    }
    EVENTS_ACTIVE.store(true, Ordering::SeqCst);
    log::info!("workspace_events: NSWorkspace observers installed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_all_sets_flag_and_notifies() {
        let pair: Arc<WakePair> = Arc::new((Mutex::new(false), Condvar::new()));
        add_waker(pair.clone());
        wake_all();
        assert!(*pair.0.lock().unwrap(), "wake_all must set the wake flag");
    }

    #[test]
    fn events_inactive_without_install() {
        // Tests never call install(); consumers must see events_active()
        // false and fall back to their legacy polling cadences.
        assert!(!events_active());
        assert!(!screen_asleep());
    }
}
