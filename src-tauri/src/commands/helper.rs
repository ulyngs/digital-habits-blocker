use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tauri::Manager;

#[cfg(target_os = "macos")]
use std::os::unix::net::UnixStream;

#[cfg(target_os = "windows")]
use std::net::TcpStream;

#[cfg(target_os = "macos")]
const SOCKET_PATH: &str = "/tmp/redd-block-helper.sock";

#[cfg(target_os = "windows")]
const HELPER_TCP_ADDR: &str = "127.0.0.1:62222";

/// Helper daemon status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelperStatus {
    pub installed: bool,
    pub running: bool,
}

/// Result from helper operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelperResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
struct IpcCommand {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    domains: Option<Vec<String>>,
    #[serde(rename = "endTime")]
    #[serde(skip_serializing_if = "Option::is_none")]
    end_time: Option<u64>,
    #[serde(rename = "blocklistId")]
    #[serde(skip_serializing_if = "Option::is_none")]
    blocklist_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpcResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    active: Option<bool>,
}

#[cfg(target_os = "macos")]
fn send_command(command: &IpcCommand) -> Result<IpcResponse, String> {
    let mut stream = UnixStream::connect(SOCKET_PATH)
        .map_err(|e| format!("Failed to connect to helper: {}", e))?;
    
    let json = serde_json::to_string(command)
        .map_err(|e| format!("Failed to serialize command: {}", e))?;
    
    writeln!(stream, "{}", json)
        .map_err(|e| format!("Failed to send command: {}", e))?;
    
    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader.read_line(&mut response_line)
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    serde_json::from_str(&response_line)
        .map_err(|e| format!("Failed to parse response: {}", e))
}

#[cfg(target_os = "windows")]
fn send_command(command: &IpcCommand) -> Result<IpcResponse, String> {
    let mut stream = TcpStream::connect(HELPER_TCP_ADDR)
        .map_err(|e| format!("Failed to connect to helper: {}", e))?;
    
    let json = serde_json::to_string(command)
        .map_err(|e| format!("Failed to serialize command: {}", e))?;
    
    writeln!(stream, "{}", json)
        .map_err(|e| format!("Failed to send command: {}", e))?;
    
    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader.read_line(&mut response_line)
        .map_err(|e| format!("Failed to read response: {}", e))?;
    
    serde_json::from_str(&response_line)
        .map_err(|e| format!("Failed to parse response: {}", e))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn send_command(_command: &IpcCommand) -> Result<IpcResponse, String> {
    Err("Helper communication not yet implemented for this platform".to_string())
}

/// Get path to the bundled helper binary
fn get_helper_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Tauri sidecars are placed next to the app binary with platform-specific suffix
    app.path().resource_dir().ok().map(|dir| {
        #[cfg(target_os = "macos")]
        let name = "redd-block-helper-aarch64-apple-darwin";
        #[cfg(target_os = "windows")]
        let name = "redd-block-helper-x86_64-pc-windows-msvc.exe";
        #[cfg(target_os = "linux")]
        let name = "redd-block-helper-x86_64-unknown-linux-gnu";
        
        dir.join(name)
    })
}

/// Check helper daemon status
#[tauri::command]
pub fn check_helper_status() -> HelperStatus {
    // Try to ping the helper - this works for both platforms
    let cmd = IpcCommand {
        action: "ping".to_string(),
        domains: None,
        end_time: None,
        blocklist_id: None,
    };
    
    let running = send_command(&cmd).map(|r| r.success).unwrap_or(false);
    
    // On Windows, check if the helper exe exists in the install location
    #[cfg(target_os = "windows")]
    let installed = {
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        let install_path = PathBuf::from(&program_data).join("ReDD Block").join("redd-block-helper.exe");
        install_path.exists() || running
    };
    
    // On macOS, check if socket exists
    #[cfg(target_os = "macos")]
    let installed = std::path::Path::new(SOCKET_PATH).exists() || running;
    
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let installed = running;
    
    HelperStatus { installed, running }
}

/// Install helper daemon
#[tauri::command]
pub async fn install_helper(app: tauri::AppHandle) -> HelperResult {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        
        // Get the bundled helper binary path
        let helper_path = match get_helper_path(&app) {
            Some(p) if p.exists() => p,
            _ => {
                // Fallback: check in the app's MacOS directory
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                
                match exe_dir {
                    Some(dir) => {
                        let helper = dir.join("redd-block-helper-aarch64-apple-darwin");
                        if helper.exists() {
                            helper
                        } else {
                            return HelperResult {
                                success: false,
                                error: Some("Helper binary not found in app bundle".to_string()),
                            };
                        }
                    }
                    None => {
                        return HelperResult {
                            success: false,
                            error: Some("Could not determine app directory".to_string()),
                        };
                    }
                }
            }
        };
        
        // Copy helper to /usr/local/bin (persistent location)
        let install_path = "/usr/local/bin/redd-block-helper";
        
        // Create launchd plist
        let plist_content = format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.redd.block.helper</string>
    <key>ProgramArguments</key>
    <array>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/redd-block-helper.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/redd-block-helper.log</string>
</dict>
</plist>"#, install_path);
        
        let plist_path = "/Library/LaunchDaemons/com.redd.block.helper.plist";
        
        // Script to copy binary, set permissions, write plist, and load daemon
        // Uses osascript to prompt for admin password
        let script = format!(
            r#"do shell script "cp '{}' '{}' && chmod 755 '{}' && echo '{}' > '{}' && launchctl load '{}'" with administrator privileges"#,
            helper_path.display(),
            install_path,
            install_path,
            plist_content.replace("\"", "\\\"").replace("\n", "\\n"),
            plist_path,
            plist_path
        );
        
        let result = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();
        
        match result {
            Ok(output) if output.status.success() => HelperResult {
                success: true,
                error: None,
            },
            Ok(output) => HelperResult {
                success: false,
                error: Some(format!("Installation failed: {}", 
                    String::from_utf8_lossy(&output.stderr))),
            },
            Err(e) => HelperResult {
                success: false,
                error: Some(format!("Failed to run installer: {}", e)),
            },
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        
        // Get the bundled helper binary path
        let helper_path = match get_helper_path(&app) {
            Some(p) if p.exists() => p,
            _ => {
                // Fallback: check next to the exe
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                
                match exe_dir {
                    Some(dir) => {
                        // Try both ARM64 and x64 variants
                        let helper_arm = dir.join("redd-block-helper-aarch64-pc-windows-msvc.exe");
                        let helper_x64 = dir.join("redd-block-helper-x86_64-pc-windows-msvc.exe");
                        if helper_arm.exists() {
                            helper_arm
                        } else if helper_x64.exists() {
                            helper_x64
                        } else {
                            return HelperResult {
                                success: false,
                                error: Some(format!("Helper binary not found. Checked: {:?} and {:?}", helper_arm, helper_x64)),
                            };
                        }
                    }
                    None => {
                        return HelperResult {
                            success: false,
                            error: Some("Could not determine app directory".to_string()),
                        };
                    }
                }
            }
        };
        
        // Install to ProgramData (accessible by scheduled tasks running as SYSTEM)
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        let install_dir = PathBuf::from(&program_data).join("ReDD Block");
        let install_path = install_dir.join("redd-block-helper.exe");
        
        // Create install directory
        if let Err(e) = std::fs::create_dir_all(&install_dir) {
            return HelperResult {
                success: false,
                error: Some(format!("Failed to create install directory: {}", e)),
            };
        }
        
        // Copy the helper binary
        if let Err(e) = std::fs::copy(&helper_path, &install_path) {
            return HelperResult {
                success: false,
                error: Some(format!("Failed to copy helper binary: {}", e)),
            };
        }
        
        // Create a Scheduled Task that runs at startup with highest privileges (admin)
        // This allows the helper to modify the hosts file
        let task_name = "ReDD Block Helper";
        
        // Delete existing task if any (ignore errors)
        let _ = Command::new("schtasks")
            .args(["/Delete", "/TN", task_name, "/F"])
            .output();
        
        // Create new scheduled task that runs at logon with highest privileges
        let create_result = Command::new("schtasks")
            .args([
                "/Create",
                "/TN", task_name,
                "/TR", &format!("\"{}\"", install_path.display()),
                "/SC", "ONLOGON",
                "/RL", "HIGHEST",
                "/F",
            ])
            .output();
        
        match create_result {
            Ok(output) if output.status.success() => {
                // Start the helper now
                let run_result = Command::new("schtasks")
                    .args(["/Run", "/TN", task_name])
                    .output();
                
                // Give it a moment to start
                std::thread::sleep(std::time::Duration::from_millis(500));
                
                match run_result {
                    Ok(r) if r.status.success() => HelperResult {
                        success: true,
                        error: None,
                    },
                    Ok(r) => HelperResult {
                        success: false,
                        error: Some(format!("Task created but failed to run: {}", 
                            String::from_utf8_lossy(&r.stderr))),
                    },
                    Err(e) => HelperResult {
                        success: false,
                        error: Some(format!("Task created but failed to run: {}", e)),
                    },
                }
            },
            Ok(output) => HelperResult {
                success: false,
                error: Some(format!("Failed to create scheduled task: {}", 
                    String::from_utf8_lossy(&output.stderr))),
            },
            Err(e) => HelperResult {
                success: false,
                error: Some(format!("Failed to run schtasks: {}", e)),
            },
        }
    }
    
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app; // Suppress unused warning
        HelperResult {
            success: false,
            error: Some("Helper installation not yet implemented for this platform".to_string()),
        }
    }
}

/// Start block via helper daemon
#[tauri::command]
pub async fn start_block_via_helper(
    domains: Vec<String>,
    end_time: u64,
    blocklist_id: String,
) -> HelperResult {
    log::info!(
        "start_block_via_helper: {} domains until {} for {}",
        domains.len(),
        end_time,
        blocklist_id
    );
    
    let cmd = IpcCommand {
        action: "start-block".to_string(),
        domains: Some(domains),
        end_time: Some(end_time),
        blocklist_id: Some(blocklist_id),
    };
    
    match send_command(&cmd) {
        Ok(response) => HelperResult {
            success: response.success,
            error: response.error,
        },
        Err(e) => HelperResult {
            success: false,
            error: Some(e),
        },
    }
}

/// Clear block via helper daemon
#[tauri::command]
pub async fn clear_block_via_helper() -> HelperResult {
    log::info!("clear_block_via_helper called");
    
    let cmd = IpcCommand {
        action: "clear-block".to_string(),
        domains: None,
        end_time: None,
        blocklist_id: None,
    };
    
    match send_command(&cmd) {
        Ok(response) => HelperResult {
            success: response.success,
            error: response.error,
        },
        Err(e) => HelperResult {
            success: false,
            error: Some(e),
        },
    }
}

/// Block websites directly (fallback without helper)
#[tauri::command]
pub async fn block_websites(domains: Vec<String>) -> HelperResult {
    log::info!("block_websites called with {} domains", domains.len());
    
    HelperResult {
        success: false,
        error: Some("Direct website blocking requires helper daemon - please install it first".to_string()),
    }
}

/// Refresh blocked apps list (notifies process watcher)
#[tauri::command]
pub fn refresh_blocked_apps() {
    log::info!("refresh_blocked_apps called");
    // Will be implemented with process watcher
}

/// Uninstall helper daemon and restore hosts file
#[tauri::command]
pub async fn uninstall_helper() -> HelperResult {
    log::info!("uninstall_helper called");
    
    // Step 1: Try to restore hosts file from backup before stopping daemon
    let cmd = IpcCommand {
        action: "restore-hosts".to_string(),
        domains: None,
        end_time: None,
        blocklist_id: None,
    };
    
    // Attempt to restore hosts file (ignore errors if daemon not running)
    let restore_result = send_command(&cmd);
    match restore_result {
        Ok(response) if response.success => {
            log::info!("Hosts file restored successfully");
        }
        Ok(response) => {
            log::warn!("Failed to restore hosts file: {:?}", response.error);
        }
        Err(e) => {
            log::warn!("Could not communicate with helper to restore hosts: {}", e);
        }
    }
    
    // Step 2: Stop and remove the helper daemon
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        
        let plist_path = "/Library/LaunchDaemons/com.redd.block.helper.plist";
        let helper_path = "/usr/local/bin/redd-block-helper";
        let socket_path = "/tmp/redd-block-helper.sock";
        let backup_path = "/etc/hosts.redd-backup";
        let state_dir = "/var/lib/redd-block";
        
        // Unload the daemon and clean up all files using osascript for admin privileges
        let unload_script = format!(
            r#"do shell script "launchctl unload '{}' 2>/dev/null || true; rm -f '{}'; rm -f '{}'; rm -f '{}'; rm -f '{}'; rm -rf '{}'" with administrator privileges"#,
            plist_path, plist_path, helper_path, socket_path, backup_path, state_dir
        );
        
        let result = Command::new("osascript")
            .arg("-e")
            .arg(&unload_script)
            .output();
        
        match result {
            Ok(output) if output.status.success() => {
                log::info!("Helper daemon and files uninstalled successfully");
                return HelperResult {
                    success: true,
                    error: None,
                };
            }
            Ok(output) => {
                let error_msg = String::from_utf8_lossy(&output.stderr);
                log::warn!("Helper daemon uninstall had issues: {}", error_msg);
                return HelperResult {
                    success: false,
                    error: Some(format!("Uninstall partially failed: {}", error_msg)),
                };
            }
            Err(e) => {
                return HelperResult {
                    success: false,
                    error: Some(format!("Failed to run uninstaller: {}", e)),
                };
            }
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        
        let task_name = "ReDD Block Helper";
        
        // Stop and delete the scheduled task
        let result = Command::new("schtasks")
            .args(["/End", "/TN", task_name])
            .output();
        
        // Log result but continue regardless
        match result {
            Ok(output) if output.status.success() => {
                log::info!("Helper task stopped successfully");
            }
            _ => {
                log::warn!("Could not stop helper task (may not be running)");
            }
        }
        
        // Delete the scheduled task
        let delete_result = Command::new("schtasks")
            .args(["/Delete", "/TN", task_name, "/F"])
            .output();
        
        match delete_result {
            Ok(output) if output.status.success() => {
                log::info!("Scheduled task deleted successfully");
                
                // Delete the helper binary and state files
                let program_data = std::env::var("PROGRAMDATA")
                    .unwrap_or_else(|_| "C:\\ProgramData".to_string());
                let helper_dir = PathBuf::from(&program_data).join("ReDD Block");
                
                if let Err(e) = std::fs::remove_dir_all(&helper_dir) {
                    log::warn!("Could not delete helper directory: {}", e);
                }
                
                // Delete the hosts file backup
                let backup_path = PathBuf::from(std::env::var("SystemRoot")
                    .unwrap_or_else(|_| "C:\\Windows".to_string()))
                    .join("System32\\drivers\\etc\\hosts.redd-backup");
                
                if backup_path.exists() {
                    if let Err(e) = std::fs::remove_file(&backup_path) {
                        log::warn!("Could not delete backup file: {}", e);
                    } else {
                        log::info!("Backup file deleted successfully");
                    }
                }
                
                return HelperResult {
                    success: true,
                    error: None,
                };
            }
            Ok(output) => {
                let error_msg = String::from_utf8_lossy(&output.stderr);
                log::warn!("Failed to delete scheduled task: {}", error_msg);
                return HelperResult {
                    success: false,
                    error: Some(format!("Failed to delete scheduled task: {}", error_msg)),
                };
            }
            Err(e) => {
                return HelperResult {
                    success: false,
                    error: Some(format!("Failed to run task deletion: {}", e)),
                };
            }
        }
    }
    
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        HelperResult {
            success: false,
            error: Some("Helper uninstall not yet implemented for this platform".to_string()),
        }
    }
}
