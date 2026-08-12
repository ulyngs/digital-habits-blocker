use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    /// Human-readable name (e.g. "Google Chrome", "Mozilla Firefox")
    pub display_name: String,
    /// Process name the app_watcher should match against (e.g. "chrome", "firefox")
    pub process_name: String,
}

/// Open a file picker dialog to select one or more applications.
///
/// This is the only command exported from this module — the
/// previous get_running_apps + minimize_app helpers were dead code
/// (registered with Tauri but never invoked from the frontend) AND
/// they shelled out to osascript / PowerShell with arguments that
/// touched System Events on macOS and triggered the Automation TCC
/// permission dialog. Removing them lets the app start with one
/// fewer system-permission prompt at first launch. Real running-
/// process introspection lives in app_watcher (sysinfo-based) and
/// in the enforcer's quit_browser path.
#[tauri::command]
pub async fn open_app_picker(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    let default_path = std::path::Path::new("/Applications");

    #[cfg(target_os = "windows")]
    let default_path = std::path::Path::new("C:\\Program Files");

    #[cfg(target_os = "linux")]
    let default_path = std::path::Path::new("/usr/share/applications");

    let files = app
        .dialog()
        .file()
        .set_title("Select Applications to Block")
        .set_directory(default_path)
        .blocking_pick_files();

    match files {
        Some(file_paths) => {
            let mut app_names = Vec::new();
            for file_path in file_paths {
                if let Ok(path) = file_path.into_path() {
                    if let Some(name) = path.file_stem() {
                        app_names.push(name.to_string_lossy().to_string());
                    } else {
                        app_names.push(path.to_string_lossy().to_string());
                    }
                }
            }
            Ok(app_names)
        }
        None => Ok(Vec::new()),
    }
}

/// Return a list of installed applications for the in-app picker.
///
/// On Windows: scans Start Menu shortcuts (.lnk) from both the
/// system-wide and per-user locations, resolves each to its target
/// executable, and returns `{ display_name, process_name }` pairs.
///
/// On macOS: scans /Applications for .app bundles.
#[tauri::command]
pub async fn list_installed_apps() -> Result<Vec<InstalledApp>, String> {
    #[cfg(target_os = "windows")]
    {
        list_installed_apps_windows()
    }

    #[cfg(target_os = "macos")]
    {
        list_installed_apps_macos()
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Ok(Vec::new())
    }
}

// ---- Windows implementation ------------------------------------------------

#[cfg(target_os = "windows")]
fn list_installed_apps_windows() -> Result<Vec<InstalledApp>, String> {
    use std::collections::{HashMap, HashSet};
    use std::ffi::OsStr;
    use std::path::PathBuf;

    // Collect .lnk files from both Start Menu locations
    let mut lnk_paths: Vec<PathBuf> = Vec::new();

    // System-wide Start Menu
    if let Ok(programdata) = std::env::var("ProgramData") {
        let system_start =
            PathBuf::from(programdata).join("Microsoft\\Windows\\Start Menu\\Programs");
        collect_lnk_files(&system_start, &mut lnk_paths);
    }

    // Per-user Start Menu
    if let Ok(appdata) = std::env::var("APPDATA") {
        let user_start = PathBuf::from(appdata).join("Microsoft\\Windows\\Start Menu\\Programs");
        collect_lnk_files(&user_start, &mut lnk_paths);
    }

    // Resolve each .lnk to its target exe
    let mut apps: Vec<InstalledApp> = Vec::new();
    let mut seen_process_names: HashSet<String> = HashSet::new();
    // Track display names to handle duplicates
    let mut display_name_to_process: HashMap<String, String> = HashMap::new();

    for lnk_path in &lnk_paths {
        let display_name = lnk_path
            .file_stem()
            .unwrap_or(OsStr::new(""))
            .to_string_lossy()
            .to_string();

        if display_name.is_empty() || should_filter_out(&display_name) {
            continue;
        }

        // Try to resolve the .lnk target
        let process_name = match resolve_lnk_target(lnk_path) {
            Some(target_path) => {
                let target = std::path::Path::new(&target_path);
                // Only include .exe targets
                match target.extension().and_then(|e| e.to_str()) {
                    Some(ext) if ext.eq_ignore_ascii_case("exe") => target
                        .file_stem()
                        .unwrap_or(OsStr::new(""))
                        .to_string_lossy()
                        .to_string(),
                    _ => continue, // Skip non-exe shortcuts (e.g., URLs, folders)
                }
            }
            None => {
                // Can't resolve — skip this shortcut
                continue;
            }
        };

        if process_name.is_empty() || should_filter_process(&process_name) {
            continue;
        }

        // Deduplicate by process name (keep first display name seen)
        let proc_lower = process_name.to_lowercase();
        if seen_process_names.contains(&proc_lower) {
            continue;
        }
        seen_process_names.insert(proc_lower.clone());
        display_name_to_process.insert(display_name.clone(), process_name.clone());

        apps.push(InstalledApp {
            display_name,
            process_name,
        });
    }

    // Sort alphabetically by display name
    apps.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });

    Ok(apps)
}

#[cfg(target_os = "windows")]
fn collect_lnk_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_lnk_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("lnk") {
                out.push(path);
            }
        }
    }
}

/// Resolve a .lnk shortcut to its target path using COM IShellLinkW.
#[cfg(target_os = "windows")]
fn resolve_lnk_target(lnk_path: &std::path::Path) -> Option<String> {
    use windows::core::GUID;
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM,
    };
    use windows::Win32::UI::Shell::IShellLinkW;

    // COM needs to be initialized on this thread
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let result = unsafe {
        // CLSID_ShellLink = {00021401-0000-0000-C000-000000000046}
        let clsid_shell_link = GUID::from_values(
            0x00021401,
            0x0000,
            0x0000,
            [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
        );

        let shell_link: IShellLinkW =
            CoCreateInstance(&clsid_shell_link, None, CLSCTX_INPROC_SERVER).ok()?;

        let persist_file: IPersistFile = windows::core::Interface::cast(&shell_link).ok()?;

        let wide_path = HSTRING::from(lnk_path.as_os_str());
        persist_file.Load(&wide_path, STGM(0)).ok()?;

        let mut target_buf = [0u16; 260]; // MAX_PATH
        let mut find_data = WIN32_FIND_DATAW::default();
        shell_link
            .GetPath(&mut target_buf, &mut find_data, 0)
            .ok()?;

        let len = target_buf
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(target_buf.len());
        let target = String::from_utf16_lossy(&target_buf[..len]);

        if target.is_empty() {
            None
        } else {
            Some(target)
        }
    };

    unsafe {
        CoUninitialize();
    }
    result
}

/// Filter out system utilities and internal tools that users shouldn't block.
#[cfg(target_os = "windows")]
fn should_filter_out(display_name: &str) -> bool {
    let lower = display_name.to_lowercase();
    let filtered = [
        "uninstall",
        "setup",
        "installer",
        "update",
        "updater",
        "repair",
        "remove",
        "readme",
        "license",
        "help",
        "component services",
        "computer management",
        "event viewer",
        "performance monitor",
        "registry editor",
        "disk cleanup",
        "task manager",
        "resource monitor",
        "system configuration",
        "print management",
        "odbc data",
        "character map",
        "steps recorder",
        "recovery",
        "windows memory",
        "system information",
        "windows fax",
        "iscsicpl",
        "dfrgui",
        "magnify",
        "narrator",
        "on-screen keyboard",
        "voice access",
        "accessibility",
        "administrative tools",
        // Internal / dev tools
        "visual studio installer",
        "developer command",
        "x86_64",
        "x64",
        "arm64",
    ];
    filtered.iter().any(|f| lower.contains(f))
}

/// Filter out system processes that should never be blocked.
#[cfg(target_os = "windows")]
fn should_filter_process(process_name: &str) -> bool {
    let lower = process_name.to_lowercase();
    let filtered = [
        "explorer",
        "cmd",
        "powershell",
        "pwsh",
        "conhost",
        "redd-block",
        "reddblock",
        "setup",
        "uninstall",
        "update",
        "msiexec",
        "mmc",
        "dxdiag",
        "regedit",
        "taskmgr",
        "control",
        "systeminfo",
        "msconfig",
        "winver",
    ];
    filtered.iter().any(|f| lower == *f)
}

// ---- macOS implementation --------------------------------------------------

#[cfg(target_os = "macos")]
fn list_installed_apps_macos() -> Result<Vec<InstalledApp>, String> {
    use std::collections::HashSet;
    use std::path::Path;

    let mut apps: Vec<InstalledApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let apps_dir = Path::new("/Applications");
    if let Ok(entries) = std::fs::read_dir(apps_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("app") {
                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                    let lower = name.to_lowercase();
                    if seen.contains(&lower) {
                        continue;
                    }
                    // Filter out system apps
                    if should_filter_macos(name) {
                        continue;
                    }
                    seen.insert(lower);
                    let process_name =
                        macos_bundle_executable(&path).unwrap_or_else(|| name.to_string());
                    apps.push(InstalledApp {
                        display_name: name.to_string(),
                        process_name,
                    });
                }
            }
        }
    }

    apps.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    Ok(apps)
}

#[cfg(target_os = "macos")]
fn macos_bundle_executable(app_path: &std::path::Path) -> Option<String> {
    let plist_path = app_path.join("Contents/Info.plist");
    let value = plist::Value::from_file(&plist_path).ok()?;
    let dict = value.as_dictionary()?;
    dict.get("CFBundleExecutable")
        .and_then(|v| v.as_string())
        .map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
fn should_filter_macos(name: &str) -> bool {
    let lower = name.to_lowercase();
    let filtered = [
        "uninstall",
        "installer",
        "migration assistant",
        "directory utility",
        "disk utility",
        "system preferences",
        "system settings",
        "system information",
    ];
    filtered.iter().any(|f| lower.contains(f))
}
