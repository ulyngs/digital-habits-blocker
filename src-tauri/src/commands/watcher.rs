//! Process Watcher - monitors running applications and minimizes blocked ones
//!
//! Uses platform-specific APIs:
//! - macOS: osascript with NSWorkspace notifications
//! - Windows: PowerShell with SetWinEventHook

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use std::io::{BufRead, BufReader};
use tauri::{AppHandle, Manager, Emitter};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Process watcher state
pub struct ProcessWatcher {
    /// Maps lowercase app name -> original case app name
    blocked_apps: HashMap<String, String>,
    watcher_process: Option<Child>,
    running: bool,
    /// Last detection time per app (for debouncing)
    last_detection: HashMap<String, Instant>,
}

impl ProcessWatcher {
    pub fn new() -> Self {
        ProcessWatcher {
            blocked_apps: HashMap::new(),
            watcher_process: None,
            running: false,
            last_detection: HashMap::new(),
        }
    }
}

impl Default for ProcessWatcher {
    fn default() -> Self {
        Self::new()
    }
}

lazy_static::lazy_static! {
    static ref WATCHER: Arc<Mutex<ProcessWatcher>> = Arc::new(Mutex::new(ProcessWatcher::new()));
}

/// Start watching for blocked app launches
#[tauri::command]
pub fn start_process_watcher(app: AppHandle) {
    {
        let mut watcher = WATCHER.lock().unwrap();
        if watcher.running {
            return;
        }
        watcher.running = true;
    }

    let watcher = WATCHER.clone();

    thread::spawn(move || {
        #[cfg(target_os = "macos")]
        start_macos_watcher(app, watcher);

        #[cfg(target_os = "windows")]
        start_windows_watcher(app, watcher);
    });
}

/// Stop watching for process launches
#[tauri::command]
pub fn stop_process_watcher() {
    let mut watcher = WATCHER.lock().unwrap();
    watcher.running = false;

    if let Some(mut process) = watcher.watcher_process.take() {
        let _ = process.kill();
    }
}

/// Update the list of blocked apps
#[tauri::command]
pub fn set_blocked_apps(apps: Vec<String>) {
    let mut watcher = WATCHER.lock().unwrap();
    watcher.blocked_apps = apps.iter()
        .map(|a| (a.to_lowercase(), a.clone()))
        .collect();
}

/// Check if any apps are currently being blocked
#[tauri::command]
pub fn has_blocked_apps() -> bool {
    let watcher = WATCHER.lock().unwrap();
    !watcher.blocked_apps.is_empty()
}

/// Internal function to minimize/hide a specific app (used by watcher)
fn internal_minimize_app(app_name: &str) {
    #[cfg(target_os = "macos")]
    {
        let escaped = app_name.replace('"', "\\\"");
        let script = format!(
            r#"tell application "System Events" to set visible of application process "{}" to false"#,
            escaped
        );

        for attempt in 1..=3 {
            let result = Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .output();

            match result {
                Ok(output) if output.status.success() => return,
                _ => {}
            }
            if attempt < 3 {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let ps_script = format!(r#"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Minimize {{
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}}
"@
$processes = Get-Process -Name "{}" -ErrorAction SilentlyContinue
foreach ($proc in $processes) {{
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {{
        [Win32Minimize]::ShowWindow($proc.MainWindowHandle, 6)
    }}
}}
"#, app_name);

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
}

/// Hide all currently blocked apps
#[tauri::command]
pub fn hide_all_blocked_apps() {
    let apps: Vec<String> = {
        let watcher = WATCHER.lock().unwrap();
        watcher.blocked_apps.values().cloned().collect()
    };

    for app in apps {
        internal_minimize_app(&app);
    }
}

#[cfg(target_os = "macos")]
fn start_macos_watcher(app: AppHandle, watcher: Arc<Mutex<ProcessWatcher>>) {
    let script = r#"
use framework "Foundation"
use framework "AppKit"

on appEvent_(theNotification)
    set appName to (theNotification's userInfo()'s objectForKey: (current application's NSWorkspaceApplicationKey))'s localizedName() as text
    log appName
end appEvent_

set theWorkspace to current application's NSWorkspace's sharedWorkspace()
set notifCenter to theWorkspace's notificationCenter()

notifCenter's addObserver:me selector:"appEvent:" |name|:(current application's NSWorkspaceDidLaunchApplicationNotification) object:(missing value)
notifCenter's addObserver:me selector:"appEvent:" |name|:(current application's NSWorkspaceDidActivateApplicationNotification) object:(missing value)

repeat
    delay 60
end repeat
"#;

    let temp_path = std::env::temp_dir().join("redd-app-watcher.applescript");
    if std::fs::write(&temp_path, script).is_err() {
        let mut w = watcher.lock().unwrap();
        w.running = false;
        return;
    }

    let mut process = match Command::new("osascript")
        .arg(&temp_path)
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(p) => p,
        Err(_) => {
            let mut w = watcher.lock().unwrap();
            w.running = false;
            return;
        }
    };

    if let Some(stderr) = process.stderr.take() {
        let reader = BufReader::new(stderr);
        let app_clone = app.clone();
        let watcher_clone = watcher.clone();

        for line in reader.lines() {
            {
                let w = watcher_clone.lock().unwrap();
                if !w.running {
                    break;
                }
            }

            if let Ok(app_name) = line {
                let app_name = app_name.trim();
                if app_name.is_empty() {
                    continue;
                }

                let is_blocked = {
                    let w = watcher_clone.lock().unwrap();
                    w.blocked_apps.contains_key(&app_name.to_lowercase())
                };

                if is_blocked {
                    let should_process = {
                        let mut w = watcher_clone.lock().unwrap();
                        let app_lower = app_name.to_lowercase();
                        let now = Instant::now();

                        if let Some(last_time) = w.last_detection.get(&app_lower) {
                            if now.duration_since(*last_time) < Duration::from_millis(500) {
                                false
                            } else {
                                w.last_detection.insert(app_lower, now);
                                true
                            }
                        } else {
                            w.last_detection.insert(app_lower, now);
                            true
                        }
                    };

                    if !should_process {
                        continue;
                    }

                    internal_minimize_app(app_name);
                    let _ = app_clone.emit("blocked-app-detected", app_name.to_string());
                }
            }
        }
    }

    let _ = process.kill();
    let _ = std::fs::remove_file(&temp_path);
    {
        let mut w = watcher.lock().unwrap();
        w.running = false;
    }
}

#[cfg(target_os = "windows")]
fn start_windows_watcher(app: AppHandle, watcher: Arc<Mutex<ProcessWatcher>>) {
    let ps_script = r#"
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class ForegroundWatcher {
    public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(IntPtr hWinEventHook);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;

    private static WinEventDelegate _delegate;
    private static IntPtr _hook;

    public static void Start() {
        _delegate = new WinEventDelegate(WinEventProc);
        _hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
            IntPtr.Zero, _delegate, 0, 0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        );
        OutputCurrentForeground();
    }

    public static void Stop() {
        if (_hook != IntPtr.Zero) {
            UnhookWinEvent(_hook);
            _hook = IntPtr.Zero;
        }
    }

    private static void WinEventProc(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime) {
        if (hwnd == IntPtr.Zero) return;
        OutputProcessForWindow(hwnd);
    }

    private static void OutputCurrentForeground() {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd != IntPtr.Zero) {
            OutputProcessForWindow(hwnd);
        }
    }

    private static void OutputProcessForWindow(IntPtr hwnd) {
        try {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if (processId > 0) {
                Process proc = Process.GetProcessById((int)processId);
                Console.WriteLine("FG:" + proc.ProcessName);
                Console.Out.Flush();
            }
        } catch { }
    }
}
"@

[ForegroundWatcher]::Start()
try {
    Add-Type -AssemblyName System.Windows.Forms
    while ($true) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 100
    }
} finally {
    [ForegroundWatcher]::Stop()
}
"#;

    let temp_path = std::env::temp_dir().join("redd-foreground-watcher.ps1");
    if std::fs::write(&temp_path, ps_script).is_err() {
        let mut w = watcher.lock().unwrap();
        w.running = false;
        return;
    }

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let mut process = match Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&temp_path)
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        Ok(p) => p,
        Err(_) => {
            let mut w = watcher.lock().unwrap();
            w.running = false;
            return;
        }
    };

    let stdout = match process.stdout.take() {
        Some(s) => s,
        None => {
            let mut w = watcher.lock().unwrap();
            w.running = false;
            return;
        }
    };

    {
        let mut w = watcher.lock().unwrap();
        w.watcher_process = Some(process);
    }

    let reader = BufReader::new(stdout);
    let app_clone = app.clone();
    let watcher_clone = watcher.clone();

    for line in reader.lines() {
        {
            let w = watcher_clone.lock().unwrap();
            if !w.running {
                break;
            }
        }

        if let Ok(line) = line {
            let trimmed = line.trim();
            if trimmed.starts_with("FG:") {
                let process_name = &trimmed[3..];

                let is_blocked = {
                    let w = watcher_clone.lock().unwrap();
                    w.blocked_apps.contains_key(&process_name.to_lowercase())
                };

                if is_blocked {
                    internal_minimize_app(process_name);
                    let _ = app_clone.emit("blocked-app-detected", process_name.to_string());
                }
            }
        }
    }

    {
        let mut w = watcher.lock().unwrap();
        if let Some(mut proc) = w.watcher_process.take() {
            let _ = proc.kill();
        }
        w.running = false;
    }

    let _ = std::fs::remove_file(&temp_path);
}

/// Get debug information (minimal - for debug window)
#[tauri::command]
pub fn get_watcher_debug_info() -> serde_json::Value {
    let watcher = WATCHER.lock().unwrap();
    let blocked_apps: Vec<String> = watcher.blocked_apps.keys().cloned().collect();
    let process_id = watcher.watcher_process.as_ref()
        .map(|p| p.id().to_string())
        .unwrap_or_else(|| "None".to_string());

    serde_json::json!({
        "running": watcher.running,
        "blocked_apps": blocked_apps,
        "blocked_apps_count": watcher.blocked_apps.len(),
        "process_id": process_id,
    })
}

/// Open the debug window
#[tauri::command]
pub async fn open_debug_window(app: AppHandle) -> Result<(), String> {
    use tauri::WebviewUrl;

    if let Some(window) = app.get_webview_window("debug") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(&app, "debug", WebviewUrl::App("debug.html".into()))
        .title("ReDD Block - Debug")
        .inner_size(500.0, 350.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("Failed to create debug window: {}", e))?;

    Ok(())
}
