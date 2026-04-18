//! ReDD Block Helper Daemon
//!
//! This privileged helper runs as root and manages website and app blocking.
//! It communicates with the main Tauri app via Unix socket (macOS/Linux)
//! or TCP port (Windows).

// Hide the console window on Windows
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
#[cfg(target_os = "windows")]
use std::net::{TcpListener, TcpStream};
#[cfg(not(target_os = "windows"))]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "windows")]
use std::sync::RwLock;
#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// Configuration
#[cfg(target_os = "windows")]
const SOCKET_PATH: &str = "127.0.0.1:62222";

#[cfg(not(target_os = "windows"))]
const SOCKET_PATH: &str = "/tmp/redd-block-helper.sock";

const BLOCK_MARKER_START: &str = "# === BEGIN REDD BLOCK (reddfocus.org) ===";
const BLOCK_MARKER_END: &str = "# === END REDD BLOCK (reddfocus.org) ===";
const SCHEDULE_EVALUATOR_POLL_SECS: u64 = 5;



#[cfg(target_os = "windows")]
const HOSTS_PATH: &str = "C:\\Windows\\System32\\drivers\\etc\\hosts";

#[cfg(not(target_os = "windows"))]
const HOSTS_PATH: &str = "/etc/hosts";

// State types
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BlockState {
    domains: Vec<String>,
    #[serde(alias = "endTime")]
    end_time: u64, // Unix timestamp ms
    #[serde(alias = "blocklistId")]
    blocklist_id: String,
}

fn default_keep_blocking_on_uninstall() -> bool {
    true
}

/// Persisted state. We support reading old format (current_block) and new (manual_blocks).
#[derive(Debug, Clone, Deserialize)]
struct HelperState {
    #[serde(default)]
    manual_blocks: Vec<BlockState>,
    #[serde(default)]
    current_block: Option<BlockState>,
    #[serde(default)]
    blocked_apps: Vec<String>,
    #[serde(default)]
    schedules: Vec<HelperSchedule>,
    #[serde(
        rename = "keepBlockingOnUninstall",
        default = "default_keep_blocking_on_uninstall"
    )]
    keep_blocking_on_uninstall: bool,
}

/// What we write to disk (only manual_blocks, no current_block).
#[derive(Debug, Serialize)]
struct HelperStatePersist {
    manual_blocks: Vec<BlockState>,
    blocked_apps: Vec<String>,
    schedules: Vec<HelperSchedule>,
    #[serde(rename = "keepBlockingOnUninstall")]
    keep_blocking_on_uninstall: bool,
}

// Schedule types
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScheduleSegment {
    #[serde(rename = "startHour")]
    start_hour: u8,
    #[serde(rename = "startMinute")]
    start_minute: u8,
    #[serde(rename = "endHour")]
    end_hour: u8,
    #[serde(rename = "endMinute")]
    end_minute: u8,
    days: Vec<u8>, // Mon=0..Sun=6
    #[serde(rename = "activeFromTimestampMs", default)]
    active_from_timestamp_ms: Option<u64>,
    #[serde(rename = "activeUntilTimestampMs", default)]
    active_until_timestamp_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HelperSchedule {
    id: String,
    domains: Vec<String>,
    #[serde(default)]
    apps: Vec<String>,
    #[serde(rename = "isPaused", default)]
    is_paused: bool,
    #[serde(rename = "pauseEndTime", default)]
    pause_end_time: Option<u64>,
    segments: Vec<ScheduleSegment>,
}

// IPC messages
#[derive(Debug, Deserialize)]
#[serde(tag = "action")]
enum IpcCommand {
    #[serde(rename = "start-block")]
    StartBlock {
        domains: Vec<String>,
        #[serde(rename = "endTime")]
        end_time: u64,
        #[serde(rename = "blocklistId")]
        blocklist_id: String,
    },
    #[serde(rename = "clear-block")]
    ClearBlock {
        #[serde(rename = "blocklistId", default)]
        blocklist_id: Option<String>,
    },
    #[serde(rename = "get-status")]
    GetStatus,
    #[serde(rename = "restore-hosts")]
    RestoreHosts,
    #[serde(rename = "set-blocked-apps")]
    SetBlockedApps {
        apps: Vec<String>,
    },
    #[serde(rename = "get-blocked-apps")]
    GetBlockedApps,
    #[serde(rename = "set-blocks")]
    SetBlocks {
        blocks: Vec<BlockState>,
    },
    #[serde(rename = "set-schedules")]
    SetSchedules {
        schedules: Vec<HelperSchedule>,
    },
    #[serde(rename = "set-keep-blocking-on-uninstall")]
    SetKeepBlockingOnUninstall {
        #[serde(rename = "keepBlockingOnUninstall")]
        keep_blocking_on_uninstall: bool,
    },
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "get-version")]
    GetVersion,
    #[serde(rename = "uninstall")]
    Uninstall,
}

#[derive(Debug, Serialize)]
struct IpcResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "endTime")]
    end_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "blocklistId")]
    blocklist_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "remainingMs")]
    remaining_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "blockedApps")]
    blocked_apps: Option<Vec<String>>,
}

fn log(message: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let line = format!("[{}] {}", now, message);
    println!("{}", line);
    
    // On Windows, also write to a log file since the console window is hidden
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        let log_dir = PathBuf::from(&program_data).join("ReDD Block");
        let _ = fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("helper.log");
        
        // Rotate log file if it exceeds 5MB
        const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;
        if let Ok(metadata) = fs::metadata(&log_path) {
            if metadata.len() > MAX_LOG_SIZE {
                let old_path = log_dir.join("helper.log.old");
                let _ = fs::rename(&log_path, &old_path);
            }
        }
        
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = writeln!(file, "{}", line);
        }
    }
}

fn get_data_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string()))
            .join("ReDD Block")
            .join("helper-state.json")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/var/lib/redd-block/helper-state.json")
    }
}

fn get_shared_app_data_path() -> PathBuf {
    get_data_path()
        .parent()
        .map(|p| p.join("redd-block-data.json"))
        .unwrap_or_else(|| PathBuf::from("redd-block-data.json"))
}

fn load_state() -> (Vec<BlockState>, Vec<String>, Vec<HelperSchedule>) {
    let path = get_data_path();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(state) = serde_json::from_str::<HelperState>(&content) {
            let mut manual_blocks = state.manual_blocks;
            if manual_blocks.is_empty() {
                if let Some(block) = state.current_block {
                    if block.end_time > now {
                        log(&format!("Migrated current_block to manual_blocks: {} domains", block.domains.len()));
                        manual_blocks.push(block);
                    }
                }
            }
            manual_blocks.retain(|b| b.end_time > now);
            if !manual_blocks.is_empty() {
                log(&format!("Restored {} active manual block(s)", manual_blocks.len()));
            }
            if !state.blocked_apps.is_empty() {
                log(&format!("Restored {} blocked apps", state.blocked_apps.len()));
            }
            if !state.schedules.is_empty() {
                log(&format!("Restored {} schedules", state.schedules.len()));
            }
            return (manual_blocks, state.blocked_apps, state.schedules);
        }
    }
    (Vec::new(), Vec::new(), Vec::new())
}

fn read_keep_blocking_preference_from_helper_state() -> Option<bool> {
    let path = get_data_path();
    let content = fs::read_to_string(&path).ok()?;
    let state = serde_json::from_str::<HelperState>(&content).ok()?;
    Some(state.keep_blocking_on_uninstall)
}

fn write_full_state(
    manual_blocks: &[BlockState],
    apps: &[String],
    schedules: &[HelperSchedule],
    keep_blocking_on_uninstall: bool,
) {
    let path = get_data_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            log(&format!("Warning: failed to create state directory: {}", e));
            return;
        }
        // Ensure directory is writable by all users so the GUI app (running
        // as a regular user) can store shared block data alongside helper state.
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o777));
        }
    }
    let state = HelperStatePersist {
        manual_blocks: manual_blocks.to_vec(),
        blocked_apps: apps.to_vec(),
        schedules: schedules.to_vec(),
        keep_blocking_on_uninstall,
    };
    match serde_json::to_string_pretty(&state) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                log(&format!("Warning: failed to persist state: {}", e));
            }
        }
        Err(e) => log(&format!("Warning: failed to serialize state: {}", e)),
    }
}

fn save_full_state(manual_blocks: &[BlockState], apps: &[String], schedules: &[HelperSchedule]) {
    let keep_blocking_on_uninstall =
        read_keep_blocking_preference_from_helper_state().unwrap_or_else(|| {
            log("Keep-blocking preference missing in helper state; defaulting to true");
            true
        });
    write_full_state(
        manual_blocks,
        apps,
        schedules,
        keep_blocking_on_uninstall,
    );
}

fn save_full_state_with_keep(
    manual_blocks: &[BlockState],
    apps: &[String],
    schedules: &[HelperSchedule],
    keep_blocking_on_uninstall: bool,
) {
    write_full_state(
        manual_blocks,
        apps,
        schedules,
        keep_blocking_on_uninstall,
    );
}

// Hosts file management
const HOSTS_BACKUP_PATH: &str = if cfg!(target_os = "windows") {
    "C:\\Windows\\System32\\drivers\\etc\\hosts.redd-backup"
} else {
    "/etc/hosts.redd-backup"
};

fn read_hosts_file() -> String {
    fs::read_to_string(HOSTS_PATH).unwrap_or_default()
}

/// Create a backup of the original hosts file if one doesn't exist
fn ensure_backup_exists() -> Result<(), String> {
    let backup_path = std::path::Path::new(HOSTS_BACKUP_PATH);
    
    if !backup_path.exists() {
        log("Creating backup of original hosts file");
        let content = read_hosts_file();
        // Strip any existing block entries so the backup is clean
        let clean = remove_block_from_hosts(&content);
        fs::write(HOSTS_BACKUP_PATH, &clean)
            .map_err(|e| format!("Failed to create hosts backup: {}", e))?;
        log(&format!("Backup created at {}", HOSTS_BACKUP_PATH));
    }
    
    Ok(())
}

/// Restore hosts file from backup
fn restore_hosts_from_backup() -> Result<(), String> {
    let backup_path = std::path::Path::new(HOSTS_BACKUP_PATH);
    
    if !backup_path.exists() {
        return Err("No backup file exists to restore from".to_string());
    }
    
    log("Restoring hosts file from backup");
    let backup_content = fs::read_to_string(HOSTS_BACKUP_PATH)
        .map_err(|e| format!("Failed to read backup: {}", e))?;
    
    // Clean any stale block entries from the backup (e.g., old-format markers)
    let clean = remove_block_from_hosts(&backup_content);
    
    // Validate the backup has essential entries
    if !clean.contains("localhost") {
        return Err("Backup file is invalid (missing localhost entry)".to_string());
    }
    
    fs::write(HOSTS_PATH, &clean)
        .map_err(|e| format!("Failed to restore hosts file: {}", e))?;
    
    flush_dns_cache();
    log("Hosts file restored successfully");
    Ok(())
}

fn write_hosts_file(content: &str) -> bool {
    // Safety check: never write an empty or near-empty hosts file
    // A valid hosts file must at least contain a localhost entry
    if !content.contains("localhost") {
        log("SAFETY: Refusing to write hosts file without localhost entry - would break DNS");
        // Attempt to restore from backup instead
        if let Err(e) = restore_hosts_from_backup() {
            log(&format!("SAFETY: Could not restore from backup either: {}", e));
            // Last resort: write a minimal valid hosts file
            let minimal = "##\n# Host Database\n##\n127.0.0.1       localhost\n255.255.255.255 broadcasthost\n::1             localhost\n";
            return fs::write(HOSTS_PATH, minimal).is_ok();
        }
        return true;
    }

    // Ensure we have a backup before any modification
    if let Err(e) = ensure_backup_exists() {
        log(&format!("Warning: {}", e));
    }
    
    // On Windows, fs::rename() often fails because the hosts file may be locked
    // by other processes (antivirus, DNS client service). Use direct write with
    // retry logic since the file can be transiently locked.
    #[cfg(target_os = "windows")]
    {
        const MAX_RETRIES: u32 = 3;
        const RETRY_DELAY_MS: u64 = 200;
        
        for attempt in 1..=MAX_RETRIES {
            match fs::write(HOSTS_PATH, content) {
                Ok(_) => {
                    // Verify the write succeeded by reading back and checking for our marker
                    match fs::read_to_string(HOSTS_PATH) {
                        Ok(readback) => {
                            if content.contains(BLOCK_MARKER_START) && !readback.contains(BLOCK_MARKER_START) {
                                log(&format!("Write verification failed on attempt {} - block markers missing from hosts file", attempt));
                                if attempt < MAX_RETRIES {
                                    thread::sleep(Duration::from_millis(RETRY_DELAY_MS));
                                    continue;
                                }
                                log("All write verification attempts failed");
                                return false;
                            }
                        }
                        Err(e) => {
                            log(&format!("Warning: could not verify hosts file after write: {}", e));
                        }
                    }
                    if attempt > 1 {
                        log(&format!("Hosts file written successfully on attempt {}", attempt));
                    }
                    return true;
                }
                Err(e) => {
                    log(&format!("Failed to write hosts file (attempt {}/{}): {}", attempt, MAX_RETRIES, e));
                    if attempt < MAX_RETRIES {
                        thread::sleep(Duration::from_millis(RETRY_DELAY_MS));
                    }
                }
            }
        }
        log("All hosts file write attempts failed");
        return false;
    }
    
    // On macOS/Linux: atomic write via temp file + rename to avoid truncation on crash
    #[cfg(not(target_os = "windows"))]
    {
        let tmp_path = format!("{}.tmp", HOSTS_PATH);
        if let Err(e) = fs::write(&tmp_path, content) {
            log(&format!("Failed to write temp hosts file: {}", e));
            return false;
        }
        if let Err(e) = fs::rename(&tmp_path, HOSTS_PATH) {
            log(&format!("Failed to rename temp hosts file: {}", e));
            // Fallback: try direct write
            let _ = fs::remove_file(&tmp_path);
            return fs::write(HOSTS_PATH, content).is_ok();
        }
        true
    }
}

fn remove_block_from_hosts(content: &str) -> String {
    let mut result = content.to_string();
    
    // Remove all current-format marker sections (handles duplicated blocks robustly).
    loop {
        let Some(start_idx) = result.find(BLOCK_MARKER_START) else {
            break;
        };
        let search_from = start_idx + BLOCK_MARKER_START.len();
        let end_after_opt = result[search_from..]
            .find(BLOCK_MARKER_END)
            .map(|offset| search_from + offset + BLOCK_MARKER_END.len());
        let before = result[..start_idx].trim_end();
        let after = match end_after_opt {
            Some(end_after) => result[end_after..].trim_start(),
            None => "",
        };
        result = if before.is_empty() {
            after.to_string()
        } else if after.is_empty() {
            before.to_string()
        } else {
            format!("{}\n{}", before, after)
        };
    }
    
    // Also clean up old-format markers (from legacy versions)
    // These used "# ReDD Block Start" / "# ReDD Block End" format
    let old_markers = [
        "# ReDD Block Start",
        "# ReDD Block End",
    ];
    for marker in &old_markers {
        result = result.lines()
            .filter(|line| line.trim() != *marker)
            .collect::<Vec<_>>()
            .join("\n");
    }
    
    result
}

/// Kept around for potential rollback if extension-based blocking needs to be
/// supplemented with hosts-file entries (e.g. a future Safari Technology
/// Preview quirk). Currently unused because website blocking lives in the
/// browser extension.
#[allow(dead_code)]
fn add_block_to_hosts(content: &str, domains: &[String]) -> String {
    let mut clean = remove_block_from_hosts(content);
    
    let mut block_lines = vec![
        String::new(),
        BLOCK_MARKER_START.to_string(),
        "# Managed by ReDD Block - DO NOT EDIT".to_string(),
    ];
    
    for domain in domains {
        let clean_domain = domain
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or(domain)
            .to_lowercase();
        
        // Safety net: never block localhost/loopback/reserved domains
        if is_protected_domain(&clean_domain) {
            log(&format!("Skipping protected domain in hosts file: {}", clean_domain));
            continue;
        }
        
        // IPv4 entries
        block_lines.push(format!("0.0.0.0 {}", clean_domain));
        block_lines.push(format!("0.0.0.0 www.{}", clean_domain));
        // IPv6 entries
        block_lines.push(format!(":: {}", clean_domain));
        block_lines.push(format!(":: www.{}", clean_domain));
    }
    
    block_lines.push(BLOCK_MARKER_END.to_string());
    block_lines.push(String::new());
    
    clean.push('\n');
    clean.push_str(&block_lines.join("\n"));
    clean
}

fn flush_dns_cache() {
    log("Flushing DNS cache...");
    
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("dscacheutil").arg("-flushcache").output();
        let _ = Command::new("killall").args(["-HUP", "mDNSResponder"]).output();
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        
        // Flush Windows DNS cache (hidden, no console window)
        match Command::new("ipconfig")
            .arg("/flushdns")
            .creation_flags(CREATE_NO_WINDOW)
            .output() 
        {
            Ok(output) => {
                if output.status.success() {
                    log("DNS cache flushed successfully");
                } else {
                    log(&format!("DNS flush warning: {}", String::from_utf8_lossy(&output.stderr)));
                }
            }
            Err(e) => log(&format!("Failed to flush DNS: {}", e)),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("systemd-resolve").arg("--flush-caches").output();
    }
}

fn is_schedule_segment_active(seg: &ScheduleSegment, now_ms: u64, current_day: u32, current_mins: u32) -> bool {
    if let (Some(active_from), Some(active_until)) = (seg.active_from_timestamp_ms, seg.active_until_timestamp_ms) {
        return now_ms >= active_from && now_ms < active_until;
    }

    let start_mins = seg.start_hour as u32 * 60 + seg.start_minute as u32;
    let end_mins = seg.end_hour as u32 * 60 + seg.end_minute as u32;

    if start_mins == end_mins {
        // Same start and end (e.g., 00:00 - 00:00) means "all day"
        return seg.days.contains(&(current_day as u8));
    }

    if end_mins > start_mins {
        return seg.days.contains(&(current_day as u8))
            && current_mins >= start_mins
            && current_mins < end_mins;
    }

    // Cross-midnight segment (e.g., 22:00 - 04:00)
    let yesterday = if current_day == 0 { 6 } else { current_day - 1 };
    let in_evening = seg.days.contains(&(current_day as u8)) && current_mins >= start_mins;
    let in_morning = seg.days.contains(&(yesterday as u8)) && current_mins < end_mins;
    in_evening || in_morning
}

/// Compute currently active schedule domains
fn get_active_schedule_domains(schedules: &[HelperSchedule]) -> Vec<String> {
    let now = chrono_now();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let current_day = now.weekday_mon0(); // Mon=0..Sun=6
    let current_mins = now.hour() * 60 + now.minute();
    
    let mut seen = HashSet::new();
    let mut domains = Vec::new();
    for schedule in schedules {
        if schedule.is_paused && schedule.pause_end_time.map(|end| end > now_ms).unwrap_or(true) {
            continue;
        }
        let is_active = schedule
            .segments
            .iter()
            .any(|seg| is_schedule_segment_active(seg, now_ms, current_day, current_mins));
        
        if is_active {
            for d in &schedule.domains {
                if seen.insert(d.clone()) {
                    domains.push(d.clone());
                }
            }
        }
    }
    domains
}

/// Compute currently active schedule apps
fn get_active_schedule_apps(schedules: &[HelperSchedule]) -> Vec<String> {
    let now = chrono_now();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let current_day = now.weekday_mon0();
    let current_mins = now.hour() * 60 + now.minute();
    
    let mut seen = HashSet::new();
    let mut apps = Vec::new();
    for schedule in schedules {
        if schedule.is_paused && schedule.pause_end_time.map(|end| end > now_ms).unwrap_or(true) {
            continue;
        }
        let is_active = schedule
            .segments
            .iter()
            .any(|seg| is_schedule_segment_active(seg, now_ms, current_day, current_mins));
        
        if is_active {
            for a in &schedule.apps {
                if seen.insert(a.clone()) {
                    apps.push(a.clone());
                }
            }
        }
    }
    apps
}

/// Helper to get current local time components without chrono dependency
struct LocalTimeInfo {
    hour: u32,
    minute: u32,
    weekday_mon0: u32, // Mon=0..Sun=6
}

impl LocalTimeInfo {
    fn hour(&self) -> u32 { self.hour }
    fn minute(&self) -> u32 { self.minute }
    fn weekday_mon0(&self) -> u32 { self.weekday_mon0 }
}

fn chrono_now() -> LocalTimeInfo {
    // Use libc::localtime_r for zero-overhead local time without shelling out
    #[cfg(not(target_os = "windows"))]
    {
        use std::mem::MaybeUninit;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as libc::time_t;
        let mut tm = MaybeUninit::<libc::tm>::uninit();
        let result = unsafe { libc::localtime_r(&timestamp, tm.as_mut_ptr()) };
        if !result.is_null() {
            let tm = unsafe { tm.assume_init() };
            // tm_wday: Sun=0..Sat=6 -> convert to Mon=0..Sun=6
            let weekday_mon0 = if tm.tm_wday == 0 { 6 } else { (tm.tm_wday - 1) as u32 };
            return LocalTimeInfo {
                hour: tm.tm_hour as u32,
                minute: tm.tm_min as u32,
                weekday_mon0,
            };
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        // Use GetLocalTime from kernel32.dll directly — zero overhead, no process spawning.
        // Previously used wmic + powershell which spawned 2 processes every 30 seconds.
        #[repr(C)]
        struct SYSTEMTIME {
            w_year: u16,
            w_month: u16,
            w_day_of_week: u16,
            w_day: u16,
            w_hour: u16,
            w_minute: u16,
            w_second: u16,
            w_milliseconds: u16,
        }
        
        extern "system" {
            fn GetLocalTime(lp_system_time: *mut SYSTEMTIME);
        }
        
        let mut st = SYSTEMTIME {
            w_year: 0, w_month: 0, w_day_of_week: 0, w_day: 0,
            w_hour: 0, w_minute: 0, w_second: 0, w_milliseconds: 0,
        };
        unsafe { GetLocalTime(&mut st) };
        
        // wDayOfWeek: Sun=0..Sat=6 -> convert to Mon=0..Sun=6
        let weekday_mon0 = if st.w_day_of_week == 0 { 6 } else { st.w_day_of_week as u32 - 1 };
        return LocalTimeInfo {
            hour: st.w_hour as u32,
            minute: st.w_minute as u32,
            weekday_mon0,
        };
    }
    
    // Fallback: use UTC (not ideal but won't crash)
    log("Warning: using UTC fallback for time - schedule evaluation may be incorrect");
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let day_secs = secs % 86400;
    let hour = (day_secs / 3600) as u32;
    let minute = ((day_secs % 3600) / 60) as u32;
    // Thursday = epoch day 0, so: (days_since_epoch + 3) % 7 = Mon=0
    let days = secs / 86400;
    let weekday_mon0 = ((days + 3) % 7) as u32;
    LocalTimeInfo { hour, minute, weekday_mon0 }
}

/// Website blocking is now handled by the browser extension + native
/// messaging host, not by the helper daemon. This function remains as a
/// migration hook: any ReDD Block markers left in `/etc/hosts` (or the
/// Windows equivalent) from older versions are scrubbed on the first call,
/// but the daemon never writes new entries.
///
/// The `state` / `schedule_state` params are still accepted so every call
/// site can keep its existing signature; domain data is ignored.
fn sync_hosts_file(
    _state: &Arc<Mutex<Vec<BlockState>>>,
    _schedule_state: &Arc<Mutex<Vec<HelperSchedule>>>,
) {
    cleanup_legacy_hosts_markers();
}

/// One-shot migration: strip any leftover `# === BEGIN REDD BLOCK ...` region
/// (and the very old `# ReDD Block Start/End` markers) from the system hosts
/// file. Never panics on I/O failure; not having write permission is the
/// normal case when the helper daemon is not running.
fn cleanup_legacy_hosts_markers() {
    let content = read_hosts_file();
    let clean = remove_block_from_hosts(&content);
    if clean == content {
        return;
    }
    if write_hosts_file(&clean) {
        flush_dns_cache();
        log("Removed legacy ReDD Block hosts entries (migration to extension-based blocking)");
    } else {
        log("Legacy ReDD Block markers still in hosts file but write failed; will retry later");
    }
}

fn start_block(
    state: &Arc<Mutex<Vec<BlockState>>>,
    app_state: &Arc<Mutex<Vec<String>>>,
    schedule_state: &Arc<Mutex<Vec<HelperSchedule>>>,
    domains: Vec<String>,
    end_time: u64,
    blocklist_id: String,
) -> IpcResponse {
    log(&format!("Starting block: {} domains for blocklist {}", domains.len(), blocklist_id));
    let block = BlockState {
        domains,
        end_time,
        blocklist_id: blocklist_id.clone(),
    };
    {
        let mut blocks = state.lock().unwrap();
        if let Some(pos) = blocks.iter().position(|b| b.blocklist_id == blocklist_id) {
            blocks[pos] = block;
        } else {
            blocks.push(block);
        }
    }
    sync_hosts_file(state, schedule_state);
    let blocks = state.lock().unwrap().clone();
    let apps = app_state.lock().unwrap().clone();
    let schedules = schedule_state.lock().unwrap().clone();
    save_full_state(&blocks, &apps, &schedules);
    log("Block started successfully");
    IpcResponse {
        success: true,
        ..Default::default()
    }
}

fn clear_block(
    state: &Arc<Mutex<Vec<BlockState>>>,
    app_state: &Arc<Mutex<Vec<String>>>,
    schedule_state: &Arc<Mutex<Vec<HelperSchedule>>>,
    blocklist_id: Option<String>,
) -> IpcResponse {
    let mut blocks = state.lock().unwrap();
    match &blocklist_id {
        Some(id) => {
            blocks.retain(|b| b.blocklist_id != *id);
            log(&format!("Cleared block for blocklist {}", id));
        }
        None => {
            blocks.clear();
            log("Cleared all manual blocks");
        }
    }
    drop(blocks);
    sync_hosts_file(state, schedule_state);
    let blocks = state.lock().unwrap().clone();
    let apps = app_state.lock().unwrap().clone();
    let schedules = schedule_state.lock().unwrap().clone();
    save_full_state(&blocks, &apps, &schedules);
    IpcResponse {
        success: true,
        ..Default::default()
    }
}

fn get_status(state: &Arc<Mutex<Vec<BlockState>>>) -> IpcResponse {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let blocks = state.lock().unwrap().clone();
    let active_block = blocks.iter().filter(|b| b.end_time > now).max_by_key(|b| b.end_time);
    match active_block {
        None => IpcResponse {
            success: true,
            active: Some(false),
            ..Default::default()
        },
        Some(block) => {
            let remaining = block.end_time.saturating_sub(now);
            IpcResponse {
                success: true,
                active: Some(true),
                domains: Some(block.domains.clone()),
                end_time: Some(block.end_time),
                blocklist_id: Some(block.blocklist_id.clone()),
                remaining_ms: Some(remaining),
                ..Default::default()
            }
        }
    }
}

// ===== App Blocking =====

/// Handle for the app watcher background thread
struct AppWatcherHandle {
    watcher_process: Option<Child>,
    running: bool,
    #[cfg(target_os = "windows")]
    run_flag: Arc<AtomicBool>,
    /// Last detection time per app (for debouncing)
    last_detection: HashMap<String, Instant>,
    /// Thread ID of the watcher thread (Windows: for posting WM_QUIT)
    thread_id: Option<u32>,
}

impl AppWatcherHandle {
    fn new() -> Self {
        AppWatcherHandle {
            watcher_process: None,
            running: false,
            #[cfg(target_os = "windows")]
            run_flag: Arc::new(AtomicBool::new(false)),
            last_detection: HashMap::new(),
            thread_id: None,
        }
    }
}

/// Check if an app name is protected (i.e., is ReDD Block itself).
/// Protected apps must never be blocked — this is a safety net in case
/// the frontend validation is bypassed.
fn is_protected_app(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    matches!(lower.as_str(), "redd block" | "redd-block" | "redd-block-helper")
}

/// Check if a domain is protected (localhost, loopback, reserved).
/// These must never be added to the hosts file block list. Currently unused
/// because the helper daemon no longer writes the hosts file; retained for
/// future fallback paths.
#[allow(dead_code)]
fn is_protected_domain(domain: &str) -> bool {
    let lower = domain.trim().to_lowercase();
    matches!(lower.as_str(),
        "localhost" | "localhost.localdomain"
        | "127.0.0.1" | "0.0.0.0" | "::1"
        | "broadcasthost" | "local"
        | "reddfocus.org" | "www.reddfocus.org"
        | "ulyngs.github.io"
    )
}

/// Hide a specific app
fn hide_app(app_name: &str) {
    // Safety net: never hide ReDD Block itself
    if is_protected_app(app_name) {
        log(&format!("Skipping hide_app: '{}' is a protected app (self-block prevention)", app_name));
        return;
    }
    #[cfg(target_os = "macos")]
    {
        // Sanitize app_name to prevent osascript injection.
        // Same allowlist approach as the Windows PowerShell fix.
        let safe_name: String = app_name.chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_' || *c == '.')
            .collect();
        
        if safe_name.is_empty() {
            log(&format!("Skipping hide_app: sanitized name is empty (original: {})", app_name));
            return;
        }
        
        let script = format!(
            r#"tell application "System Events" to set visible of application process "{}" to false"#,
            safe_name
        );
        
        // Try up to 3 times with small delays
        for attempt in 1..=3 {
            let result = Command::new("osascript")
                .arg("-e")
                .arg(&script)
                .output();
            
            match result {
                Ok(output) if output.status.success() => {
                    log(&format!("Hidden app: {} (attempt {})", app_name, attempt));
                    return;
                }
                Ok(_) | Err(_) => {
                    if attempt < 3 {
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }
        log(&format!("Failed to hide app after 3 attempts: {}", app_name));
    }
    
    #[cfg(target_os = "windows")]
    {
        // Sanitize app_name for safety
        let safe_name: String = app_name.chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_' || *c == '.')
            .collect();
        
        if safe_name.is_empty() {
            log(&format!("Skipping hide_app: sanitized name is empty (original: {})", app_name));
            return;
        }
        
        // Native Windows API for near-instant minimization (no PowerShell overhead)
        struct MinimizeData {
            target_name: String,
            minimized_count: u32,
        }
        
        extern "system" fn minimize_callback(hwnd: isize, lparam: isize) -> i32 {
            unsafe {
                #[link(name = "user32")]
                extern "system" {
                    fn IsWindowVisible(hwnd: isize) -> i32;
                    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
                    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
                }
                #[link(name = "kernel32")]
                extern "system" {
                    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
                    fn CloseHandle(h: isize) -> i32;
                    fn QueryFullProcessImageNameW(h: isize, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
                }
                
                let data = &mut *(lparam as *mut MinimizeData);
                
                // Skip invisible windows
                if IsWindowVisible(hwnd) == 0 {
                    return 1;
                }
                
                // Get process ID for this window
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if pid == 0 { return 1; }
                
                // Open process to query its name
                let handle = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
                if handle == 0 { return 1; }
                
                let mut buf = [0u16; 260];
                let mut size = 260u32;
                let matched = if QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut size) != 0 {
                    let path = String::from_utf16_lossy(&buf[..size as usize]);
                    if let Some(filename) = path.rsplit('\\').next() {
                        let name = filename.strip_suffix(".exe").unwrap_or(filename);
                        name.eq_ignore_ascii_case(&data.target_name)
                    } else {
                        false
                    }
                } else {
                    false
                };
                
                CloseHandle(handle);
                
                if matched {
                    ShowWindow(hwnd, 6); // SW_MINIMIZE
                    data.minimized_count += 1;
                }
                
                1 // continue enumeration
            }
        }
        
        #[link(name = "user32")]
        extern "system" {
            fn EnumWindows(cb: extern "system" fn(isize, isize) -> i32, lp: isize) -> i32;
        }
        
        let mut data = MinimizeData {
            target_name: safe_name.clone(),
            minimized_count: 0,
        };
        
        unsafe {
            EnumWindows(minimize_callback, &mut data as *mut MinimizeData as isize);
        }
        
        if data.minimized_count > 0 {
            log(&format!("Minimized {} window(s) for app (native): {}", data.minimized_count, safe_name));
        }
    }
}

#[cfg(target_os = "macos")]
fn get_frontmost_app_name() -> Option<String> {
    let script = r#"tell application "System Events" to get name of first application process whose frontmost is true"#;
    match Command::new("osascript").arg("-e").arg(script).output() {
        Ok(output) if output.status.success() => {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if name.is_empty() {
                None
            } else {
                Some(name)
            }
        }
        _ => None,
    }
}

/// Hide all currently blocked apps
fn hide_all_blocked_apps(app_state: &Arc<Mutex<Vec<String>>>) {
    let apps = app_state.lock().unwrap().clone();
    log(&format!("Hiding {} blocked apps", apps.len()));
    for app in apps {
        hide_app(&app);
    }
}

/// Start the app watcher background thread
fn start_app_watcher(
    app_state: &Arc<Mutex<Vec<String>>>,
    app_watcher_handle: &Arc<Mutex<Option<AppWatcherHandle>>>,
) {
    #[cfg(target_os = "windows")]
    let run_flag = {
        let mut handle = app_watcher_handle.lock().unwrap();
        if let Some(ref h) = *handle {
            if h.running {
                log("App watcher already running, skipping start");
                return;
            }
        }
        let mut new_handle = AppWatcherHandle::new();
        new_handle.running = true;
        new_handle.run_flag.store(true, Ordering::SeqCst);
        let run_flag = Arc::clone(&new_handle.run_flag);
        *handle = Some(new_handle);
        run_flag
    };

    #[cfg(not(target_os = "windows"))]
    {
        let mut handle = app_watcher_handle.lock().unwrap();
        if let Some(ref h) = *handle {
            if h.running {
                log("App watcher already running, skipping start");
                return;
            }
        }
        *handle = Some(AppWatcherHandle::new());
        if let Some(ref mut h) = *handle {
            h.running = true;
        }
    }
    
    let app_state_clone = Arc::clone(app_state);
    let handle_clone = Arc::clone(app_watcher_handle);
    
    thread::spawn(move || {
        #[cfg(target_os = "macos")]
        run_macos_app_watcher(app_state_clone, handle_clone);
        
        #[cfg(target_os = "windows")]
        run_windows_app_watcher(app_state_clone, handle_clone, run_flag);
    });
}

/// Stop the app watcher
fn stop_app_watcher(app_watcher_handle: &Arc<Mutex<Option<AppWatcherHandle>>>) {
    let mut handle = app_watcher_handle.lock().unwrap();
    if let Some(ref mut h) = *handle {
        h.running = false;
        #[cfg(target_os = "windows")]
        h.run_flag.store(false, Ordering::SeqCst);
        // On Windows, post WM_QUIT to the watcher thread's message loop
        #[cfg(target_os = "windows")]
        if let Some(tid) = h.thread_id {
            #[link(name = "user32")]
            extern "system" {
                fn PostThreadMessageW(thread_id: u32, msg: u32, wparam: usize, lparam: isize) -> i32;
            }
            unsafe { PostThreadMessageW(tid, 0x0012, 0, 0); } // WM_QUIT
        }
        if let Some(mut process) = h.watcher_process.take() {
            let _ = process.kill();
        }
        log("App watcher stopped");
    }
    *handle = None;
}

/// Set blocked apps, starting/stopping watcher as needed
fn set_blocked_apps(
    state: &Arc<Mutex<Vec<BlockState>>>,
    app_state: &Arc<Mutex<Vec<String>>>,
    schedule_state: &Arc<Mutex<Vec<HelperSchedule>>>,
    app_watcher_handle: &Arc<Mutex<Option<AppWatcherHandle>>>,
    apps: Vec<String>,
) -> IpcResponse {
    log(&format!("Setting blocked apps: {:?}", apps));
    let apps: Vec<String> = apps.into_iter().filter(|a| {
        if is_protected_app(a) {
            log(&format!("Filtered protected app from blocked list: {}", a));
            false
        } else {
            true
        }
    }).collect();
    *app_state.lock().unwrap() = apps;
    let blocks = state.lock().unwrap().clone();
    let apps_for_save = app_state.lock().unwrap().clone();
    let schedules = schedule_state.lock().unwrap().clone();
    save_full_state(&blocks, &apps_for_save, &schedules);
    
    // Update the effective blocked-apps list (manual + schedule)
    #[cfg(target_os = "windows")]
    update_effective_blocked_apps();

    // Compute effective apps (manual + active schedule) for watcher lifecycle decisions.
    let mut effective_apps = app_state.lock().unwrap().clone();
    let schedule_apps = get_active_schedule_apps(&schedule_state.lock().unwrap().clone());
    for app in schedule_apps {
        if !effective_apps.iter().any(|a| a.eq_ignore_ascii_case(&app)) {
            effective_apps.push(app);
        }
    }

    if !effective_apps.is_empty() {
        // Start watcher if not running
        start_app_watcher(app_state, app_watcher_handle);
        // Hide currently open blocked apps from both manual and active schedules
        for app in &effective_apps {
            hide_app(app);
        }
    } else {
        stop_app_watcher(app_watcher_handle);
    }
    
    IpcResponse {
        success: true,
        ..Default::default()
    }
}

#[cfg(target_os = "macos")]
fn run_macos_app_watcher(
    app_state: Arc<Mutex<Vec<String>>>,
    handle: Arc<Mutex<Option<AppWatcherHandle>>>,
) {
    let script = r#"
use framework "Foundation"
use framework "AppKit"

on appEvent_(theNotification)
    set appName to (theNotification's userInfo()'s objectForKey: (current application's NSWorkspaceApplicationKey))'s localizedName() as text
    log appName
end appEvent_

set theWorkspace to current application's NSWorkspace's sharedWorkspace()
set notifCenter to theWorkspace's notificationCenter()

-- Listen for app launches
notifCenter's addObserver:me selector:"appEvent:" |name|:(current application's NSWorkspaceDidLaunchApplicationNotification) object:(missing value)

-- Listen for app activations (when user clicks to bring app forward)
notifCenter's addObserver:me selector:"appEvent:" |name|:(current application's NSWorkspaceDidActivateApplicationNotification) object:(missing value)

repeat
    delay 60
end repeat
"#;

    // Write script to temp file
    let temp_path = std::env::temp_dir().join("redd-helper-app-watcher.applescript");
    if std::fs::write(&temp_path, script).is_err() {
        log("Failed to write AppleScript file for app watcher");
        let mut h = handle.lock().unwrap();
        *h = None;
        return;
    }

    let mut process = match Command::new("osascript")
        .arg(&temp_path)
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(p) => p,
        Err(e) => {
            log(&format!("Failed to start macOS app watcher: {}", e));
            let mut h = handle.lock().unwrap();
            *h = None;
            return;
        }
    };

    log("macOS app watcher started in helper daemon");
    
    // Store the process handle
    {
        let mut h = handle.lock().unwrap();
        if let Some(ref mut _wh) = *h {
            // We can't store the process directly since we need stderr
            // The process handle will be managed via the running flag
        }
    }

    // Fallback guard: periodically verify the frontmost app and hide it if blocked.
    // This catches edge cases where rapid focus/activation spam misses event handling.
    {
        let app_state_fallback = Arc::clone(&app_state);
        let handle_fallback = Arc::clone(&handle);
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(2));

                let watcher_running = {
                    let h = handle_fallback.lock().unwrap();
                    matches!(&*h, Some(wh) if wh.running)
                };
                if !watcher_running {
                    break;
                }

                let Some(frontmost_app) = get_frontmost_app_name() else {
                    continue;
                };

                let is_blocked = is_app_effectively_blocked(&frontmost_app, &app_state_fallback);
                if !is_blocked {
                    continue;
                }

                let should_process = {
                    let mut h = handle_fallback.lock().unwrap();
                    if let Some(ref mut wh) = *h {
                        let app_lower = frontmost_app.to_lowercase();
                        let now = Instant::now();
                        if let Some(last_time) = wh.last_detection.get(&app_lower) {
                            if now.duration_since(*last_time) < Duration::from_millis(500) {
                                false
                            } else {
                                wh.last_detection.insert(app_lower, now);
                                true
                            }
                        } else {
                            wh.last_detection.insert(app_lower, now);
                            true
                        }
                    } else {
                        false
                    }
                };

                if should_process {
                    log(&format!(
                        "Fallback foreground check detected blocked app: {}",
                        frontmost_app
                    ));
                    hide_app(&frontmost_app);
                }
            }
        });
    }

    // Read stderr (AppleScript 'log' outputs to stderr)
    if let Some(stderr) = process.stderr.take() {
        let reader = BufReader::new(stderr);
        
        for line in reader.lines() {
            // Check if we should stop
            {
                let h = handle.lock().unwrap();
                match &*h {
                    Some(wh) if wh.running => {},
                    _ => break,
                }
            }
            
            if let Ok(app_name) = line {
                let app_name = app_name.trim();
                if app_name.is_empty() {
                    continue;
                }
                
                // Check if this app is blocked
                let is_blocked = is_app_effectively_blocked(app_name, &app_state);
                
                if is_blocked {
                    // Debounce: skip if we detected this app within the last 500ms
                    let should_process = {
                        let mut h = handle.lock().unwrap();
                        if let Some(ref mut wh) = *h {
                            let app_lower = app_name.to_lowercase();
                            let now = Instant::now();
                            
                            if let Some(last_time) = wh.last_detection.get(&app_lower) {
                                if now.duration_since(*last_time) < Duration::from_millis(500) {
                                    false
                                } else {
                                    wh.last_detection.insert(app_lower, now);
                                    true
                                }
                            } else {
                                wh.last_detection.insert(app_lower, now);
                                true
                            }
                        } else {
                            false
                        }
                    };
                    
                    if !should_process {
                        continue;
                    }
                    
                    log(&format!("Blocked app detected: {}", app_name));
                    hide_app(app_name);
                }
            }
        }
    }

    // Clean up
    let _ = process.kill();
    let _ = std::fs::remove_file(&temp_path);
    
    {
        let mut h = handle.lock().unwrap();
        *h = None;
    }
    
    log("macOS app watcher stopped in helper daemon");
}

// Global effective blocked-apps list for the WinEvent callback.
// Uses Arc<Vec<String>> behind RwLock to avoid raw-pointer lifetime races.
#[cfg(target_os = "windows")]
static EFFECTIVE_BLOCKED_APPS: std::sync::OnceLock<RwLock<Arc<Vec<String>>>> = std::sync::OnceLock::new();

// Global references so update_effective_blocked_apps() can recompute the merged list.
#[cfg(target_os = "windows")]
static GLOBAL_APP_STATE: std::sync::OnceLock<Arc<Mutex<Vec<String>>>> = std::sync::OnceLock::new();
#[cfg(target_os = "windows")]
static GLOBAL_SCHEDULE_STATE: std::sync::OnceLock<Arc<Mutex<Vec<HelperSchedule>>>> = std::sync::OnceLock::new();

// Global schedule state for macOS watcher so it can evaluate effective
// blocked apps (manual apps ∪ active schedule apps).
#[cfg(target_os = "macos")]
static GLOBAL_SCHEDULE_STATE_MAC: std::sync::OnceLock<Arc<Mutex<Vec<HelperSchedule>>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn is_app_effectively_blocked(app_name: &str, app_state: &Arc<Mutex<Vec<String>>>) -> bool {
    {
        let apps = app_state.lock().unwrap();
        if apps.iter().any(|a| a.eq_ignore_ascii_case(app_name)) {
            return true;
        }
    }

    if let Some(schedule_state) = GLOBAL_SCHEDULE_STATE_MAC.get() {
        let schedules = schedule_state.lock().unwrap().clone();
        for app in get_active_schedule_apps(&schedules) {
            if app.eq_ignore_ascii_case(app_name) {
                return true;
            }
        }
    }

    false
}

/// Recompute the effective blocked-apps list (manual apps ∪ active schedule apps)
/// and store it in EFFECTIVE_BLOCKED_APPS so the WinEvent callback can read it.
#[cfg(target_os = "windows")]
fn update_effective_blocked_apps() {
    let mut merged = HashSet::new();

    if let Some(app_state) = GLOBAL_APP_STATE.get() {
        for a in app_state.lock().unwrap().iter() {
            merged.insert(a.to_lowercase());
        }
    }
    if let Some(sched_state) = GLOBAL_SCHEDULE_STATE.get() {
        let schedules = sched_state.lock().unwrap().clone();
        for a in get_active_schedule_apps(&schedules) {
            merged.insert(a.to_lowercase());
        }
    }

    let list: Vec<String> = merged.into_iter().collect();
    log(&format!("Effective blocked apps updated: {:?}", list));
    let store = EFFECTIVE_BLOCKED_APPS.get_or_init(|| RwLock::new(Arc::new(Vec::new())));
    if let Ok(mut guard) = store.write() {
        *guard = Arc::new(list);
    }
}

/// Read the current effective blocked-apps list.
#[cfg(target_os = "windows")]
fn read_effective_blocked_apps() -> Arc<Vec<String>> {
    let store = EFFECTIVE_BLOCKED_APPS.get_or_init(|| RwLock::new(Arc::new(Vec::new())));
    if let Ok(guard) = store.read() {
        Arc::clone(&guard)
    } else {
        Arc::new(Vec::new())
    }
}

#[cfg(target_os = "windows")]
fn run_windows_app_watcher(
    app_state: Arc<Mutex<Vec<String>>>,
    handle: Arc<Mutex<Option<AppWatcherHandle>>>,
    run_flag: Arc<AtomicBool>,
) {
    // FFI declarations
    #[link(name = "user32")]
    extern "system" {
        fn SetWinEventHook(
            event_min: u32, event_max: u32, hmod: isize,
            callback: extern "system" fn(isize, u32, isize, i32, i32, u32, u32),
            id_process: u32, id_thread: u32, flags: u32,
        ) -> isize;
        fn UnhookWinEvent(hook: isize) -> i32;
        fn GetMessageW(msg: *mut [u8; 48], hwnd: isize, min: u32, max: u32) -> i32;
        fn TranslateMessage(msg: *const [u8; 48]) -> i32;
        fn DispatchMessageW(msg: *const [u8; 48]) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentThreadId() -> u32;
    }

    // Store global references so update_effective_blocked_apps() can recompute
    let _ = GLOBAL_APP_STATE.set(app_state);
    // Note: GLOBAL_SCHEDULE_STATE is set separately via init_global_schedule_state()

    if !run_flag.load(Ordering::SeqCst) {
        log("Windows watcher startup cancelled before initialization");
        return;
    }

    // Build the initial effective blocked-apps list
    update_effective_blocked_apps();

    // Store our thread ID so stop_app_watcher can post WM_QUIT
    let thread_id = unsafe { GetCurrentThreadId() };
    {
        let mut h = handle.lock().unwrap();
        if let Some(ref mut wh) = *h {
            wh.thread_id = Some(thread_id);
        }
    }

    if !run_flag.load(Ordering::SeqCst) {
        log("Windows watcher startup cancelled before hook install");
        let mut h = handle.lock().unwrap();
        *h = None;
        return;
    }

    // WinEvent callback — fires on foreground changes and window restorations
    extern "system" fn on_foreground(
        _hook: isize, event: u32, hwnd: isize,
        _id_object: i32, _id_child: i32, _thread: u32, _time: u32,
    ) {
        if hwnd == 0 { return; }
        // Only act on EVENT_SYSTEM_FOREGROUND (0x0003) and EVENT_SYSTEM_MINIMIZEEND (0x0017)
        if event != 0x0003 && event != 0x0017 { return; }

        #[link(name = "user32")]
        extern "system" {
            fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
            fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn CloseHandle(h: isize) -> i32;
            fn QueryFullProcessImageNameW(h: isize, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
        }

        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 { return; }

            let proc_handle = OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if proc_handle == 0 { return; }

            let mut buf = [0u16; 260];
            let mut size = 260u32;
            if QueryFullProcessImageNameW(proc_handle, 0, buf.as_mut_ptr(), &mut size) != 0 {
                let path = String::from_utf16_lossy(&buf[..size as usize]);
                if let Some(filename) = path.rsplit('\\').next() {
                    let name_lower = filename
                        .strip_suffix(".exe")
                        .unwrap_or(filename)
                        .to_lowercase();

                    // Lock-free read of the effective blocked-apps list
                    let is_blocked = read_effective_blocked_apps()
                        .iter()
                        .any(|a| *a == name_lower);

                    if is_blocked {
                        log(&format!("Blocked app focused, minimizing: {}", name_lower));
                        ShowWindow(hwnd, 11); // SW_FORCEMINIMIZE
                    }
                }
            }

            CloseHandle(proc_handle);
        }
    }

    // Install the hook
    let hook = unsafe {
        SetWinEventHook(
            0x0003, 0x0017, // EVENT_SYSTEM_FOREGROUND through EVENT_SYSTEM_MINIMIZEEND
            0, on_foreground,
            0, 0,
            0x0000 | 0x0002, // WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
        )
    };

    if hook == 0 {
        log("Failed to set WinEvent hook for app watcher");
        let mut h = handle.lock().unwrap();
        *h = None;
        return;
    }

    log("Windows app watcher started (native, event-driven)");

    // Minimize any already-open blocked apps right now
    let apps = read_effective_blocked_apps();
    for app in apps.iter() {
        hide_app(app);
    }

    // Run the Windows message loop — blocks with zero CPU until an event arrives
    // The loop exits when WM_QUIT is posted (by stop_app_watcher)
    unsafe {
        let mut msg = [0u8; 48]; // MSG struct
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    // Cleanup
    unsafe { UnhookWinEvent(hook); }

    {
        let mut h = handle.lock().unwrap();
        *h = None;
    }

    log("Windows app watcher stopped");
}

fn handle_command(
    state: &Arc<Mutex<Vec<BlockState>>>,
    app_state: &Arc<Mutex<Vec<String>>>,
    schedule_state: &Arc<Mutex<Vec<HelperSchedule>>>,
    app_watcher_handle: &Arc<Mutex<Option<AppWatcherHandle>>>,
    cmd: IpcCommand,
) -> IpcResponse {
    match cmd {
        IpcCommand::StartBlock { domains, end_time, blocklist_id } => {
            start_block(state, app_state, schedule_state, domains, end_time, blocklist_id)
        }
        IpcCommand::ClearBlock { blocklist_id } => clear_block(state, app_state, schedule_state, blocklist_id),
        IpcCommand::GetStatus => get_status(state),
        IpcCommand::RestoreHosts => {
            match restore_hosts_from_backup() {
                Ok(()) => IpcResponse {
                    success: true,
                    message: Some("Hosts file restored from backup without changing helper state".to_string()),
                    ..Default::default()
                },
                Err(e) => IpcResponse {
                    success: false,
                    error: Some(e),
                    ..Default::default()
                },
            }
        }
        IpcCommand::SetBlockedApps { apps } => {
            set_blocked_apps(state, app_state, schedule_state, app_watcher_handle, apps)
        }
        IpcCommand::GetBlockedApps => {
            let apps = app_state.lock().unwrap().clone();
            IpcResponse {
                success: true,
                blocked_apps: Some(apps),
                ..Default::default()
            }
        }
        IpcCommand::SetBlocks { blocks } => {
            log(&format!("Setting {} blocks atomically", blocks.len()));
            for b in &blocks {
                log(&format!("  Block '{}': {} domains, endTime={}",
                    b.blocklist_id, b.domains.len(), b.end_time));
            }
            *state.lock().unwrap() = blocks;
            sync_hosts_file(state, schedule_state);
            let blocks = state.lock().unwrap().clone();
            let apps = app_state.lock().unwrap().clone();
            let scheds = schedule_state.lock().unwrap().clone();
            save_full_state(&blocks, &apps, &scheds);
            IpcResponse {
                success: true,
                ..Default::default()
            }
        }
        IpcCommand::SetSchedules { schedules } => {
            log(&format!("Setting {} schedules", schedules.len()));
            for s in &schedules {
                log(&format!("  Schedule '{}': {} domains, {} apps, {} segments",
                    s.id, s.domains.len(), s.apps.len(), s.segments.len()));
            }
            
            *schedule_state.lock().unwrap() = schedules;

            #[cfg(target_os = "windows")]
            update_effective_blocked_apps();
            
            // Sync hosts file immediately
            sync_hosts_file(state, schedule_state);
            
            // Sync app blocking from schedules
            let sched = schedule_state.lock().unwrap().clone();
            let schedule_apps = get_active_schedule_apps(&sched);
            let manual_apps = app_state.lock().unwrap().clone();
            let mut all_apps: Vec<String> = manual_apps;
            for a in schedule_apps {
                if !all_apps.contains(&a) {
                    all_apps.push(a);
                }
            }
            #[cfg(target_os = "windows")]
            {
                let still_need = !read_effective_blocked_apps().is_empty();
                if still_need {
                    start_app_watcher(app_state, app_watcher_handle);
                } else {
                    stop_app_watcher(app_watcher_handle);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                if !all_apps.is_empty() {
                    start_app_watcher(app_state, app_watcher_handle);
                } else {
                    stop_app_watcher(app_watcher_handle);
                }
            }
            let blocks = state.lock().unwrap().clone();
            let apps = app_state.lock().unwrap().clone();
            let scheds = schedule_state.lock().unwrap().clone();
            save_full_state(&blocks, &apps, &scheds);
            IpcResponse {
                success: true,
                ..Default::default()
            }
        }
        IpcCommand::SetKeepBlockingOnUninstall { keep_blocking_on_uninstall } => {
            log(&format!(
                "Setting keepBlockingOnUninstall to {}",
                keep_blocking_on_uninstall
            ));
            let blocks = state.lock().unwrap().clone();
            let apps = app_state.lock().unwrap().clone();
            let scheds = schedule_state.lock().unwrap().clone();
            save_full_state_with_keep(&blocks, &apps, &scheds, keep_blocking_on_uninstall);
            IpcResponse {
                success: true,
                ..Default::default()
            }
        }
        IpcCommand::Ping => IpcResponse {
            success: true,
            message: Some("pong".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            ..Default::default()
        },
        IpcCommand::GetVersion => IpcResponse {
            success: true,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            ..Default::default()
        },
        IpcCommand::Uninstall => {
            log("Received uninstall command - cleaning up...");
            stop_app_watcher(app_watcher_handle);
            *state.lock().unwrap() = Vec::new();
            *app_state.lock().unwrap() = Vec::new();
            *schedule_state.lock().unwrap() = Vec::new();
            save_full_state(&[], &[], &[]);
            let _ = restore_hosts_from_backup();
            
            // Delete state file
            let state_path = get_data_path();
            let _ = fs::remove_file(&state_path);
            
            // Spawn a thread to remove ourselves after responding
            thread::spawn(|| {
                // Give time for response to be sent
                thread::sleep(std::time::Duration::from_millis(500));
                perform_self_cleanup();
            });
            
            IpcResponse {
                success: true,
                message: Some("Helper uninstalling...".to_string()),
                ..Default::default()
            }
        },
    }
}

impl Default for IpcResponse {
    fn default() -> Self {
        IpcResponse {
            success: false,
            error: None,
            message: None,
            active: None,
            domains: None,
            end_time: None,
            blocklist_id: None,
            remaining_ms: None,
            version: None,
            blocked_apps: None,
        }
    }
}

/// Perform self-cleanup - remove the daemon/scheduled task and exit
fn perform_self_cleanup() {
    log("Performing self-cleanup...");
    
    #[cfg(target_os = "macos")]
    {
        let install_path = "/Library/PrivilegedHelperTools/com.redd.block.helper";
        let legacy_helper_path = "/usr/local/bin/redd-block-helper";

        // Remove launchd daemon and exit
        log("Removing launchd daemon...");
        let _ = std::process::Command::new("launchctl")
            .args(["remove", "com.redd.block.helper"])
            .output();
        // Legacy fallback for older label used by previous installs.
        let _ = std::process::Command::new("launchctl")
            .args(["remove", "org.reddfocus.redd-block-helper"])
            .output();
        
        // Delete the plist file
        let _ = fs::remove_file("/Library/LaunchDaemons/com.redd.block.helper.plist");
        // Legacy fallback for older plist path.
        let _ = fs::remove_file("/Library/LaunchDaemons/org.reddfocus.redd-block-helper.plist");
        // Remove installed helper binaries.
        let _ = fs::remove_file(install_path);
        let _ = fs::remove_file(legacy_helper_path);
        
        // Delete the socket
        let _ = fs::remove_file(SOCKET_PATH);
    }
    
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        let install_dir = PathBuf::from(&program_data).join("ReDD Block");
        let helper_path = std::env::current_exe()
            .ok()
            .unwrap_or_else(|| install_dir.join("redd-block-helper.exe"));
        let helper_log_path = install_dir.join("helper.log");
        let helper_old_log_path = install_dir.join("helper.log.old");
        let install_log_path = install_dir.join("install.log");
        let state_path = install_dir.join("helper-state.json");
        
        // Remove scheduled task (hidden)
        log("Removing scheduled task...");
        let _ = std::process::Command::new("schtasks")
            .args(["/Delete", "/TN", "ReDD Block Helper", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        // Delete helper artifacts after this process exits. Avoid removing the whole
        // directory because shared desktop app data may live alongside the helper.
        let cleanup_cmd = format!(
            "timeout /t 2 /nobreak > NUL & del /F /Q \"{}\" > NUL 2>&1 & del /F /Q \"{}\" > NUL 2>&1 & del /F /Q \"{}\" > NUL 2>&1 & del /F /Q \"{}\" > NUL 2>&1 & del /F /Q \"{}\" > NUL 2>&1 & netsh advfirewall firewall delete rule name=\"ReDD Block Helper\" > NUL 2>&1",
            helper_path.display(),
            helper_log_path.display(),
            helper_old_log_path.display(),
            install_log_path.display(),
            state_path.display()
        );
        let _ = std::process::Command::new("cmd")
            .args(["/C", &cleanup_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    
    log("Cleanup complete, exiting...");
    std::process::exit(0);
}

enum AppInstallState {
    Detected,
    NotDetectedButSharedDataPresent,
    NotDetected,
}

/// Check if the main application still exists in a location we can confidently detect.
fn check_app_install_state() -> AppInstallState {
    let shared_app_data_exists = get_shared_app_data_path().exists();

    #[cfg(target_os = "macos")]
    {
        let app_paths = [
            "/Applications/ReDD Block.app",
            "/Applications/redd-block.app",
            // Also check user Applications folder
            &format!("{}/Applications/ReDD Block.app", 
                std::env::var("HOME").unwrap_or_else(|_| "/".to_string())),
            &format!("{}/Applications/redd-block.app",
                std::env::var("HOME").unwrap_or_else(|_| "/".to_string())),
        ];
        if app_paths.iter().any(|p| std::path::Path::new(p).exists()) {
            AppInstallState::Detected
        } else if shared_app_data_exists {
            AppInstallState::NotDetectedButSharedDataPresent
        } else {
            AppInstallState::NotDetected
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "".to_string());
        let program_files = std::env::var("PROGRAMFILES").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let program_files_x86 = std::env::var("PROGRAMFILES(X86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
        
        let paths = [
            format!("{}\\Programs\\redd-block\\ReDD Block.exe", local_app_data),
            format!("{}\\Programs\\ReDD Block\\ReDD Block.exe", local_app_data),
            format!("{}\\ReDD Block\\ReDD Block.exe", program_files),
            format!("{}\\redd-block\\ReDD Block.exe", program_files),
            format!("{}\\ReDD Block\\ReDD Block.exe", program_files_x86),
            format!("{}\\redd-block\\ReDD Block.exe", program_files_x86),
        ];
        
        if paths.iter().any(|p| std::path::Path::new(p).exists()) {
            AppInstallState::Detected
        } else if shared_app_data_exists {
            AppInstallState::NotDetectedButSharedDataPresent
        } else {
            AppInstallState::NotDetected
        }
    }
    
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        AppInstallState::Detected
    }
}

fn read_keep_blocking_preference() -> bool {
    if let Some(value) = read_keep_blocking_preference_from_helper_state() {
        return value;
    }

    log("Keep-blocking preference missing in helper state; defaulting to true");
    true
}

/// Thread that periodically checks if the main app still exists
fn app_existence_checker(
    state: Arc<Mutex<Vec<BlockState>>>,
    app_state: Arc<Mutex<Vec<String>>>,
    schedule_state: Arc<Mutex<Vec<HelperSchedule>>>,
) {
    loop {
        thread::sleep(std::time::Duration::from_secs(300));
        match check_app_install_state() {
            AppInstallState::Detected => continue,
            AppInstallState::NotDetectedButSharedDataPresent => {
                log("Main application not detected in standard install paths, but shared app data still exists - skipping auto-cleanup");
                continue;
            }
            AppInstallState::NotDetected => {
                log("Main application no longer detected");
                let keep_blocking = read_keep_blocking_preference();
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64;
                let has_active_block = state.lock().unwrap().iter().any(|b| b.end_time > now);
                let has_blocked_apps = !app_state.lock().unwrap().is_empty();
                let has_schedules = !schedule_state.lock().unwrap().is_empty();
                log(&format!(
                    "Uninstall decision: keepBlockingOnUninstall={}, has_active_block={}, has_blocked_apps={}, has_schedules={}",
                    keep_blocking, has_active_block, has_blocked_apps, has_schedules
                ));
                if keep_blocking && (has_active_block || has_blocked_apps || has_schedules) {
                    log("Keep blocking enabled and blocks/schedules are configured - continuing");
                    continue;
                }
                log("Performing cleanup...");
                *state.lock().unwrap() = Vec::new();
                *app_state.lock().unwrap() = Vec::new();
                *schedule_state.lock().unwrap() = Vec::new();
                save_full_state(&[], &[], &[]);
                let _ = restore_hosts_from_backup();
                
                // Delete state file
                let state_path = get_data_path();
                let _ = fs::remove_file(&state_path);
                
                // Self-cleanup
                perform_self_cleanup();
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn handle_client(
    state: Arc<Mutex<Vec<BlockState>>>,
    app_state: Arc<Mutex<Vec<String>>>,
    schedule_state: Arc<Mutex<Vec<HelperSchedule>>>,
    app_watcher_handle: Arc<Mutex<Option<AppWatcherHandle>>>,
    stream: UnixStream,
) {
    let reader = BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    
    for line in reader.lines() {
        if let Ok(line) = line {
            if line.trim().is_empty() {
                continue;
            }
            
            let response = match serde_json::from_str::<IpcCommand>(&line) {
                Ok(cmd) => {
                    log(&format!("Received command: {:?}", cmd));
                    handle_command(&state, &app_state, &schedule_state, &app_watcher_handle, cmd)
                }
                Err(e) => IpcResponse {
                    success: false,
                    error: Some(format!("Invalid JSON: {}", e)),
                    ..Default::default()
                },
            };
            
            if let Ok(json) = serde_json::to_string(&response) {
                let _ = writeln!(writer, "{}", json);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn handle_client(
    state: Arc<Mutex<Vec<BlockState>>>,
    app_state: Arc<Mutex<Vec<String>>>,
    schedule_state: Arc<Mutex<Vec<HelperSchedule>>>,
    app_watcher_handle: Arc<Mutex<Option<AppWatcherHandle>>>,
    stream: TcpStream,
) {
    let reader = BufReader::new(stream.try_clone().unwrap());
    let mut writer = stream;
    
    for line in reader.lines() {
        if let Ok(line) = line {
            if line.trim().is_empty() {
                continue;
            }
            
            let response = match serde_json::from_str::<IpcCommand>(&line) {
                Ok(cmd) => {
                    log(&format!("Received command: {:?}", cmd));
                    handle_command(&state, &app_state, &schedule_state, &app_watcher_handle, cmd)
                }
                Err(e) => IpcResponse {
                    success: false,
                    error: Some(format!("Invalid command: {}", e)),
                    ..Default::default()
                },
            };
            
            if let Ok(json) = serde_json::to_string(&response) {
                let _ = writeln!(writer, "{}", json);
            }
        }
    }
}

fn expiry_checker(
    state: Arc<Mutex<Vec<BlockState>>>,
    app_state: Arc<Mutex<Vec<String>>>,
    schedule_state: Arc<Mutex<Vec<HelperSchedule>>>,
) {
    loop {
        thread::sleep(Duration::from_secs(1));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let expired = {
            let mut blocks = state.lock().unwrap();
            let len_before = blocks.len();
            blocks.retain(|b| b.end_time > now);
            len_before != blocks.len()
        };
        if expired {
            log("One or more blocks expired, syncing hosts");
            sync_hosts_file(&state, &schedule_state);
            let blocks = state.lock().unwrap().clone();
            let apps = app_state.lock().unwrap().clone();
            let schedules = schedule_state.lock().unwrap().clone();
            save_full_state(&blocks, &apps, &schedules);
        }
    }
}

/// Schedule evaluator thread: checks every 30 seconds if schedule state has changed
fn schedule_evaluator(
    state: Arc<Mutex<Vec<BlockState>>>,
    schedule_state: Arc<Mutex<Vec<HelperSchedule>>>,
    app_state: Arc<Mutex<Vec<String>>>,
    app_watcher_handle: Arc<Mutex<Option<AppWatcherHandle>>>,
) {
    let mut last_schedule_domains: Vec<String> = Vec::new();
    let mut last_schedule_apps: Vec<String> = Vec::new();
    
    // Initial sync on startup
    {
        let schedules = schedule_state.lock().unwrap().clone();
        if !schedules.is_empty() {
            let domains = get_active_schedule_domains(&schedules);
            let apps = get_active_schedule_apps(&schedules);
            if !domains.is_empty() || !apps.is_empty() {
                log(&format!("Schedule evaluator: initial sync - {} domains, {} apps active",
                    domains.len(), apps.len()));
                sync_hosts_file(&state, &schedule_state);
                if !apps.is_empty() {
                    start_app_watcher(&app_state, &app_watcher_handle);
                    for app in &apps {
                        hide_app(app);
                    }
                }
                last_schedule_domains = domains;
                last_schedule_apps = apps;
            }
        }
    }
    
    loop {
        thread::sleep(Duration::from_secs(SCHEDULE_EVALUATOR_POLL_SECS));
        
        let schedules = schedule_state.lock().unwrap().clone();
        if schedules.is_empty() {
            if !last_schedule_domains.is_empty() {
                // Schedules were cleared — sync hosts to remove schedule domains
                log("Schedule evaluator: all schedules removed");
                sync_hosts_file(&state, &schedule_state);
                last_schedule_domains.clear();
                last_schedule_apps.clear();
            }
            continue;
        }
        
        let current_domains = get_active_schedule_domains(&schedules);
        let current_apps = get_active_schedule_apps(&schedules);
        
        // Check if domain set changed
        let mut sorted_current = current_domains.clone();
        sorted_current.sort();
        let mut sorted_last = last_schedule_domains.clone();
        sorted_last.sort();
        
        if sorted_current != sorted_last {
            log(&format!("Schedule evaluator: domain change detected ({} -> {} domains)",
                last_schedule_domains.len(), current_domains.len()));
            sync_hosts_file(&state, &schedule_state);
            let blocks = state.lock().unwrap().clone();
            let apps = app_state.lock().unwrap().clone();
            save_full_state(&blocks, &apps, &schedules);
            last_schedule_domains = current_domains;
        }
        
        // Check if apps set changed
        let mut sorted_current_apps = current_apps.clone();
        sorted_current_apps.sort();
        let mut sorted_last_apps = last_schedule_apps.clone();
        sorted_last_apps.sort();
        
        if sorted_current_apps != sorted_last_apps {
            log(&format!("Schedule evaluator: app change detected ({} -> {} apps)",
                last_schedule_apps.len(), current_apps.len()));
            
            // Update the effective blocked-apps list (manual + schedule)
            #[cfg(target_os = "windows")]
            update_effective_blocked_apps();

            if !current_apps.is_empty() {
                start_app_watcher(&app_state, &app_watcher_handle);
                // Hide any currently open newly-blocked schedule apps
                for app in &current_apps {
                    hide_app(app);
                }
            } else {
                // Check if manual apps still need the watcher
                let manual_apps = app_state.lock().unwrap().clone();
                if manual_apps.is_empty() {
                    stop_app_watcher(&app_watcher_handle);
                }
            }
            
            last_schedule_apps = current_apps;
        }
    }
}

fn main() {
    // Install panic hook so panics are captured to the log file.
    // This is especially important on Windows where windows_subsystem = "windows"
    // hides the console, meaning panics would otherwise be invisible.
    std::panic::set_hook(Box::new(|info| {
        log(&format!("PANIC: {}", info));
    }));
    
    log("ReDD Block Helper Daemon starting...");
    log(&format!("Platform: {}", std::env::consts::OS));
    
    // Rotate macOS log file on startup if it exceeds 5MB.
    // On macOS, launchd captures stdout/stderr to this file — we can only
    // rotate it at startup since we don't control the file handle.
    #[cfg(target_os = "macos")]
    {
        let log_path = "/var/log/redd-block-helper.log";
        const MAX_LOG_SIZE: u64 = 5 * 1024 * 1024;
        if let Ok(metadata) = fs::metadata(log_path) {
            if metadata.len() > MAX_LOG_SIZE {
                let old_path = format!("{}.old", log_path);
                let _ = fs::rename(log_path, &old_path);
                log("Rotated macOS log file (exceeded 5MB)");
            }
        }
    }
    
    // Migration path for users upgrading from the hosts-file era: strip any
    // `# === BEGIN REDD BLOCK ===` region we may have left behind so web
    // traffic is never silently blackholed by leftover entries. Website
    // blocking now lives in the browser extension + native messaging host.
    cleanup_legacy_hosts_markers();

    // Load persisted state
    let (initial_block, initial_apps, initial_schedules) = load_state();
    let state = Arc::new(Mutex::new(initial_block));
    let app_state = Arc::new(Mutex::new(initial_apps.clone()));
    let schedule_state = Arc::new(Mutex::new(initial_schedules));

    // Store global schedule state reference for update_effective_blocked_apps()
    #[cfg(target_os = "windows")]
    {
        let _ = GLOBAL_SCHEDULE_STATE.set(Arc::clone(&schedule_state));
    }
    #[cfg(target_os = "macos")]
    {
        let _ = GLOBAL_SCHEDULE_STATE_MAC.set(Arc::clone(&schedule_state));
    }
    let app_watcher_handle: Arc<Mutex<Option<AppWatcherHandle>>> = Arc::new(Mutex::new(None));
    
    // If we have persisted blocked apps, start the app watcher
    if !initial_apps.is_empty() {
        log(&format!("Starting app watcher for {} persisted blocked apps", initial_apps.len()));
        start_app_watcher(&app_state, &app_watcher_handle);
        // Hide any currently open blocked apps
        hide_all_blocked_apps(&app_state);
    }
    
    // Start expiry checker thread
    let state_clone = Arc::clone(&state);
    let app_state_clone = Arc::clone(&app_state);
    let schedule_state_clone = Arc::clone(&schedule_state);
    thread::spawn(move || expiry_checker(state_clone, app_state_clone, schedule_state_clone));
    
    // Start schedule evaluator thread
    let state_clone = Arc::clone(&state);
    let schedule_state_clone = Arc::clone(&schedule_state);
    let app_state_clone = Arc::clone(&app_state);
    let watcher_clone = Arc::clone(&app_watcher_handle);
    thread::spawn(move || schedule_evaluator(state_clone, schedule_state_clone, app_state_clone, watcher_clone));
    
    // Start app existence checker thread (for self-cleanup when app is uninstalled)
    let state_clone = Arc::clone(&state);
    let app_state_clone = Arc::clone(&app_state);
    let schedule_state_clone = Arc::clone(&schedule_state);
    thread::spawn(move || app_existence_checker(state_clone, app_state_clone, schedule_state_clone));
    
    // Start IPC server
    #[cfg(not(target_os = "windows"))]
    {
        // Remove old socket if exists
        let _ = fs::remove_file(SOCKET_PATH);
        
        let listener = UnixListener::bind(SOCKET_PATH).expect("Failed to bind socket");
        
        // Set socket permissions
        let _ = fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o666));
        
        log(&format!("Listening on {}", SOCKET_PATH));
        
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                log("Client connected");
                let state_clone = Arc::clone(&state);
                let app_state_clone = Arc::clone(&app_state);
                let schedule_state_clone = Arc::clone(&schedule_state);
                let watcher_clone = Arc::clone(&app_watcher_handle);
                thread::spawn(move || handle_client(state_clone, app_state_clone, schedule_state_clone, watcher_clone, stream));
            }
        }
    }
    
    #[cfg(target_os = "windows")]
    {
        // Load auth token for TCP IPC authentication
        
        // Try binding to TCP port with retries (handles TIME_WAIT from previous process)
        let mut listener = None;
        for attempt in 1..=5 {
            match TcpListener::bind(SOCKET_PATH) {
                Ok(l) => {
                    log(&format!("Successfully bound to TCP port on attempt {}", attempt));
                    listener = Some(l);
                    break;
                }
                Err(e) => {
                    log(&format!("Failed to bind TCP port (attempt {}): {}", attempt, e));
                    if attempt < 5 {
                        thread::sleep(Duration::from_secs(1));
                    }
                }
            }
        }
        
        let listener = match listener {
            Some(l) => l,
            None => {
                log("Failed to bind TCP port after 5 attempts, exiting");
                std::process::exit(1);
            }
        };
        
        log(&format!("Listening on {}", SOCKET_PATH));
        
        for stream in listener.incoming() {
            if let Ok(stream) = stream {
                log("Client connected");
                let state_clone = Arc::clone(&state);
                let app_state_clone = Arc::clone(&app_state);
                let schedule_state_clone = Arc::clone(&schedule_state);
                let watcher_clone = Arc::clone(&app_watcher_handle);
                thread::spawn(move || handle_client(state_clone, app_state_clone, schedule_state_clone, watcher_clone, stream));
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
use std::os::unix::fs::PermissionsExt;
