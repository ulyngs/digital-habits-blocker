// Tauri commands that control the JOMO-style website-automation watcher
// (macOS only). The watcher itself lives in `crate::web_automation`; this
// is the thin command/lifecycle layer the frontend and app setup drive,
// mirroring `commands/enforcement.rs`.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

use crate::web_automation::{self, PermissionInfo, SupportedBrowser, WebAutomationHandle};

pub struct WebAutomationState(pub Mutex<Option<WebAutomationHandle>>);

impl Default for WebAutomationState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Resolve the bundled block page to a `file://` base URL (no query
/// string). The page is staged at `<resources>/blocked/blocked.html` by
/// the bundler (see `bundle.resources` in tauri.conf.json). We log loudly
/// if it's missing so a bad bundle path shows up immediately in dev
/// rather than as silent redirects to a 404.
fn resolve_block_page_url(app: &AppHandle) -> Option<String> {
    let dir = match app.path().resource_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("web_automation: cannot resolve resource dir: {e}");
            return None;
        }
    };
    let page = dir.join("blocked").join("blocked.html");
    if !page.exists() {
        log::warn!(
            "web_automation: bundled block page not found at {} — redirects will 404",
            page.display()
        );
    }
    let url = web_automation::path_to_file_url(&page);
    if url.is_none() {
        log::warn!(
            "web_automation: could not build file:// URL for {}",
            page.display()
        );
    }
    url
}

/// Start the automation watcher if not already running. Idempotent.
///
/// Gated on EULA acceptance only (`should_run_web_automation`) — NOT
/// FDA. Apple Events need just the per-browser Automation grant, which
/// the watcher surfaces itself on the first event during an active
/// block. The frontend calls this from `runPostAcceptanceStartup`.
#[tauri::command]
pub fn web_automation_start(app: AppHandle, state: State<WebAutomationState>) {
    let mut slot = state.0.lock().expect("web_automation lock");
    if slot.is_none() {
        match resolve_block_page_url(&app) {
            Some(url) => *slot = Some(web_automation::start(app.clone(), url)),
            None => {
                log::warn!("web_automation: not starting — no block page URL");
                return;
            }
        }
    }
    let ok = crate::cross_app_consent::should_run_web_automation();
    if let Some(h) = slot.as_ref() {
        h.set_enabled(ok);
        if !ok {
            log::info!("web_automation: web_automation_start ignored — EULA not accepted");
        }
    }
}

/// Pause the watcher without tearing it down. The loop goes idle (sends
/// no Apple Events) until re-enabled.
#[tauri::command]
pub fn web_automation_pause(state: State<WebAutomationState>) {
    if let Some(h) = state.0.lock().expect("web_automation lock").as_ref() {
        h.set_enabled(false);
    }
}

/// Per-browser Automation-permission snapshot for the diagnostics /
/// onboarding UI.
///
/// Runs off the main thread — the underlying TCC query shares the
/// Apple Event lock with the automation tick and must not block UI.
#[tauri::command]
pub async fn web_automation_permission_status(
    app: AppHandle,
    state: State<'_, WebAutomationState>,
    launch_probe: Option<bool>,
    launch_probe_browser: Option<String>,
    launch_probe_browsers: Option<Vec<String>>,
) -> Result<Vec<PermissionInfo>, String> {
    use crate::web_automation::PermState;
    let launch_probe_all = launch_probe.unwrap_or(false);
    let launch_probe_browser = launch_probe_browser.filter(|s| !s.trim().is_empty());
    let launch_probe_browsers: Vec<String> = launch_probe_browsers
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect();
    let app_for_filter = app.clone();
    let cached = state
        .0
        .lock()
        .ok()
        .and_then(|s| s.as_ref().map(|h| h.permission_status()));
    let running = tauri::async_runtime::spawn_blocking(web_automation::running_supported_browsers)
        .await
        .map_err(|e| e.to_string())?;
    let running: std::collections::HashSet<_> = running.into_iter().collect();
    let list = tauri::async_runtime::spawn_blocking(move || {
        SupportedBrowser::all()
            .into_iter()
            .filter(|b| {
                crate::blocking_method::uses_automation(&app_for_filter, b.settings_key())
            })
            .map(|b| {
                let cached_state = cached.as_ref().and_then(|list| {
                    list.iter().find(|i| i.browser == b).map(|i| i.state)
                });
                let probe_launch = if !launch_probe_browsers.is_empty() {
                    launch_probe_browsers
                        .iter()
                        .any(|t| web_automation::browser_matches_launch_probe_target(b, t))
                } else if let Some(ref target) = launch_probe_browser {
                    web_automation::browser_matches_launch_probe_target(b, target)
                } else {
                    launch_probe_all
                };
                let st = web_automation::resolve_permission_state_for_status(
                    b,
                    cached_state,
                    running.contains(&b),
                    probe_launch,
                );
                PermissionInfo {
                    browser: b,
                    label: b.label(),
                    state: st,
                    running: running.contains(&b),
                }
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(guard) = state.0.lock() {
        if let Some(h) = guard.as_ref() {
            for info in &list {
                // Keep the watcher cache aligned with UI polls so a grant
                // survives a browser quit but a revocation while open is
                // not overwritten by stale Granted on the next closed poll.
                if matches!(info.state, PermState::Granted | PermState::Denied) {
                    h.record_permission(info.browser, info.state);
                }
            }
        }
    }
    Ok(list)
}

/// Surface the system Automation prompt for one browser on demand (used
/// by the onboarding / "grant access" affordance). `browser` is one of
/// the labels from `permission_status` ("Safari", "Chrome", "Brave",
/// "Edge").
#[tauri::command]
pub async fn request_automation_permission(browser: String) -> Result<(), String> {
    let target = SupportedBrowser::all()
        .into_iter()
        .find(|b| b.label().eq_ignore_ascii_case(&browser))
        .ok_or_else(|| format!("unknown browser: {browser}"))?;
    tauri::async_runtime::spawn_blocking(move || web_automation::trigger_permission_prompt(target))
        .await
        .map_err(|e| e.to_string())?
}

/// Open System Settings → Privacy & Security → Automation so the user can
/// toggle the per-app grants ReDD Blocker needs.
#[tauri::command]
pub fn open_automation_settings() -> Result<(), String> {
    web_automation::open_automation_settings()
}

/// Register the watcher state handle on the app.
pub fn register<R: tauri::Runtime>(app: &tauri::App<R>) {
    app.manage(WebAutomationState::default());
}

/// Auto-start the watcher at launch, paused until the EULA is accepted
/// (and any v1.x→2.0 migration onboarding is finished). Unlike the
/// enforcer this does NOT wait on FDA — Apple Events don't need it. The
/// watcher only sends Apple Events while a block is actually active, so a
/// started-and-enabled watcher is silent until the first block, at which
/// point the per-browser Automation prompt appears.
pub fn auto_start(app: &AppHandle) {
    let url = match resolve_block_page_url(app) {
        Some(u) => u,
        None => {
            log::warn!("web_automation: skipping auto_start — no block page URL");
            return;
        }
    };
    let h = web_automation::start(app.clone(), url);

    let pending = crate::commands::migration::migration_pending_sync();
    let eula_ok = crate::cross_app_consent::should_run_web_automation();
    let enabled = !pending && eula_ok;
    h.set_enabled(enabled);
    if pending {
        log::info!("web_automation: starting paused (migration onboarding pending)");
    } else if !eula_ok {
        log::info!("web_automation: starting paused (EULA not accepted)");
    }

    let state = app.state::<WebAutomationState>();
    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(h);
    };
}
