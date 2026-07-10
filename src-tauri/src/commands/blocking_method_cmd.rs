//! Tauri commands for per-browser blocking method (macOS).

use std::collections::HashMap;

use serde_json::Value;
use tauri::AppHandle;

use crate::blocking_method::{self, Method};

#[tauri::command]
pub fn get_blocking_methods(app: AppHandle) -> HashMap<String, String> {
    blocking_method::read_map(&app)
}

#[tauri::command]
pub fn set_blocking_method(
    app: AppHandle,
    browser: String,
    method: String,
) -> Result<HashMap<String, String>, String> {
    blocking_method::validate_mac_blocking_method_key(&browser)?;
    let parsed = blocking_method::validate_method(&method)?;

    let path = super::canonical_data_path(&app).ok_or_else(|| "no app data path".to_string())?;
    let mut data = read_data(&path).unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    if !data.is_object() {
        data = Value::Object(serde_json::Map::new());
    }
    let obj = data.as_object_mut().unwrap();
    let settings = obj
        .entry("settings".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let settings_obj = settings.as_object_mut().unwrap();
    let methods = settings_obj
        .entry("blockingMethods".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    methods
        .as_object_mut()
        .unwrap()
        .insert(browser.clone(), Value::String(parsed.as_str().to_string()));

    write_data(&path, &data).map_err(|e| format!("write data: {e}"))?;
    apply_side_effects(&app, &browser, parsed)?;
    log::info!("blocking_method: {browser} -> {}", parsed.as_str());
    Ok(blocking_method::read_map_from_path(&path))
}

fn apply_side_effects(app: &AppHandle, browser: &str, method: Method) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, browser, method);
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    match (browser, method) {
        ("safari", Method::Extension) => {
            let path = super::canonical_data_path(app).ok_or_else(|| "no app data path".to_string())?;
            crate::app_group::sync_blocklist_from(&path)
                .map_err(|e| format!("App Group sync for Safari: {e}"))?;
        }
        (browser, Method::Extension) => {
            if let Some(target) = blocking_method::native_host_target(browser) {
                crate::native_host_install::install_native_host_for(target)
                    .map_err(|e| format!("native-host install for {browser}: {e}"))?;
            }
            if let Some(target) = blocking_method::extension_hint_target(browser) {
                crate::extension_install::install_chromium_hint(target)
                    .map_err(|e| format!("extension hint for {browser}: {e}"))?;
            }
        }
        ("safari", Method::Automation) => {
            crate::app_group::remove_blocklist_mirror()
                .map_err(|e| format!("App Group cleanup for Safari: {e}"))?;
        }
        (browser, Method::Automation) => {
            if let Some(target) = blocking_method::native_host_target(browser) {
                crate::native_host_install::uninstall_native_host_for(target)
                    .map_err(|e| format!("native-host uninstall for {browser}: {e}"))?;
            }
        }
    }
    Ok(())
}

fn read_data(path: &std::path::Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_data(path: &std::path::Path, data: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(data)?;
    super::data::write_data_file_atomic(path, &body)
}
