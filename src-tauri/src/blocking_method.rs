//! Per-browser website blocking method on macOS (Automation vs extension).
//!
//! Chrome, Brave, Edge, and Safari default to Automation; power users may
//! opt into the ReDD Focus extension path for instant redirects.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;
use tauri::AppHandle;

pub const METHOD_AUTOMATION: &str = "automation";
pub const METHOD_EXTENSION: &str = "extension";

pub const MAC_BLOCKING_METHOD_KEYS: &[&str] = &["chrome", "brave", "edge", "safari"];

/// Chromium browsers on macOS (native-messaging extension path).
pub const MAC_CHROMIUM_KEYS: &[&str] = &["chrome", "brave", "edge"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Automation,
    Extension,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Automation => METHOD_AUTOMATION,
            Method::Extension => METHOD_EXTENSION,
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            METHOD_AUTOMATION => Some(Method::Automation),
            METHOD_EXTENSION => Some(Method::Extension),
            _ => None,
        }
    }
}

/// Read `settings.blockingMethods` from the canonical data file.
/// Served from the shared mtime-keyed parse cache — the Automation
/// watcher calls this once per running browser on every 1 s tick.
pub fn read_map_from_path(path: &Path) -> HashMap<String, String> {
    match crate::data_cache::read(path) {
        Some(data) => read_map_from_value(&data),
        None => HashMap::new(),
    }
}

pub fn read_map(app: &AppHandle) -> HashMap<String, String> {
    crate::commands::canonical_data_path(app)
        .map(|p| read_map_from_path(&p))
        .unwrap_or_default()
}

fn read_map_from_value(data: &Value) -> HashMap<String, String> {
    data.get("settings")
        .and_then(|s| s.get("blockingMethods"))
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Effective blocking method for a browser key on this platform.
#[allow(clippy::needless_return)] // cfg dispatch: the return is load-bearing on the other platform
pub fn method_for_key_at_path(path: &Path, key: &str) -> Method {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, key);
        return Method::Extension;
    }
    #[cfg(target_os = "macos")]
    {
        match key {
            "firefox" => Method::Extension,
            k if MAC_BLOCKING_METHOD_KEYS.contains(&k) => read_map_from_path(path)
                .get(k)
                .and_then(|s| Method::parse(s))
                .unwrap_or(Method::Automation),
            _ => Method::Automation,
        }
    }
}

pub fn method_for_key(app: &AppHandle, key: &str) -> Method {
    crate::commands::canonical_data_path(app)
        .map(|p| method_for_key_at_path(&p, key))
        .unwrap_or(Method::Automation)
}

pub fn uses_automation_at_path(path: &Path, key: &str) -> bool {
    method_for_key_at_path(path, key) == Method::Automation
}

pub fn uses_automation(app: &AppHandle, key: &str) -> bool {
    method_for_key(app, key) == Method::Automation
}

pub fn is_mac_blocking_method_key(key: &str) -> bool {
    MAC_BLOCKING_METHOD_KEYS.contains(&key)
}

pub fn validate_mac_blocking_method_key(key: &str) -> Result<(), String> {
    if is_mac_blocking_method_key(key) {
        Ok(())
    } else {
        Err(format!("unsupported browser for blocking method: {key}"))
    }
}

pub fn validate_method(method: &str) -> Result<Method, String> {
    Method::parse(method).ok_or_else(|| format!("invalid blocking method: {method}"))
}

#[cfg(not(target_os = "ios"))]
pub fn native_host_target(key: &str) -> Option<crate::native_host_install::BrowserTarget> {
    use crate::native_host_install::BrowserTarget;
    match key {
        "chrome" => Some(BrowserTarget::Chrome),
        "brave" => Some(BrowserTarget::Brave),
        "edge" => Some(BrowserTarget::Edge),
        "firefox" => Some(BrowserTarget::Firefox),
        _ => None,
    }
}

#[cfg(not(target_os = "ios"))]
pub fn extension_hint_target(key: &str) -> Option<crate::extension_install::BrowserTarget> {
    use crate::extension_install::BrowserTarget;
    match key {
        "chrome" => Some(BrowserTarget::Chrome),
        "brave" => Some(BrowserTarget::Brave),
        "edge" => Some(BrowserTarget::Edge),
        _ => None,
    }
}
