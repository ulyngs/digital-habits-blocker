//! Shared blocklist-derivation helpers.
//!
//! Given the `redd-block-data.json` file (or an already-parsed `AppData`),
//! compute the set of domains that should currently be blocked. The derivation
//! intentionally mirrors `updateHostsFile()` in `src/app.js` and
//! `sync_hosts_file()` in the old helper-daemon, so every code path in the
//! project agrees on what "currently blocked" means.
//!
//! This module is intentionally dependency-light: it does not touch Tauri
//! globals. That lets the native-messaging-host CLI mode
//! (`redd-block --native-host`) reuse it without initializing the UI stack.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Domains that must never be blocked, even if a user somehow adds them
/// (e.g. by editing the JSON by hand). Matches the frontend `PROTECTED_DOMAINS`
/// list and the helper-daemon's `is_protected_domain()` defense-in-depth.
pub const PROTECTED_DOMAINS: &[&str] = &[
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "reddfocus.org",
    "www.reddfocus.org",
];

/// Subset of `AppData` we actually need for deriving the active blocklist.
/// Everything else in the file is ignored via `#[serde(default)]` on a catch-all.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedAppData {
    #[serde(default)]
    pub blocklists: Vec<DerivedBlocklist>,
    #[serde(default)]
    pub active_blocks: Vec<DerivedActiveBlock>,
    #[serde(default)]
    pub schedules: Vec<DerivedSchedule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedBlocklist {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub websites: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedActiveBlock {
    pub blocklist_id: String,
    #[serde(default)]
    pub start_time: u64,
    #[serde(default)]
    pub end_time: u64,
    #[serde(default)]
    pub is_paused: bool,
    #[serde(default)]
    pub pause_end_time: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedSchedule {
    pub blocklist_id: String,
    #[serde(default)]
    pub segments: Vec<DerivedSegment>,
    #[serde(default)]
    pub is_paused: bool,
    #[serde(default)]
    pub pause_end_time: Option<u64>,
    #[serde(default)]
    pub repeat_type: Option<String>,
    #[serde(default)]
    pub repeat_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedSegment {
    #[serde(default)]
    pub start_hour: u32,
    #[serde(default)]
    pub start_minute: u32,
    #[serde(default)]
    pub end_hour: u32,
    #[serde(default)]
    pub end_minute: u32,
    #[serde(default)]
    pub days: Vec<u32>,
    #[serde(default)]
    pub active_from_timestamp_ms: Option<u64>,
    #[serde(default)]
    pub active_until_timestamp_ms: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Helper to get current local time components without a chrono dependency.
/// Matches the helper-daemon's hand-rolled `LocalTimeInfo` / `chrono_now()` so
/// schedule evaluation agrees across the two crates.
struct LocalTimeInfo {
    hour: u32,
    minute: u32,
    second: u32,
    weekday_mon0: u32,
}

#[cfg(not(target_os = "windows"))]
fn local_time_info() -> LocalTimeInfo {
    use std::mem::MaybeUninit;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as libc::time_t;
    let mut tm = MaybeUninit::<libc::tm>::uninit();
    let result = unsafe { libc::localtime_r(&timestamp, tm.as_mut_ptr()) };
    if !result.is_null() {
        let tm = unsafe { tm.assume_init() };
        // tm_wday: Sun=0..Sat=6 → convert to Mon=0..Sun=6.
        let weekday_mon0 = if tm.tm_wday == 0 { 6 } else { (tm.tm_wday - 1) as u32 };
        return LocalTimeInfo {
            hour: tm.tm_hour as u32,
            minute: tm.tm_min as u32,
            second: tm.tm_sec as u32,
            weekday_mon0,
        };
    }
    utc_time_info()
}

#[cfg(target_os = "windows")]
fn local_time_info() -> LocalTimeInfo {
    #[repr(C)]
    struct SystemTime {
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
        fn GetLocalTime(lp_system_time: *mut SystemTime);
    }
    let mut st = SystemTime {
        w_year: 0,
        w_month: 0,
        w_day_of_week: 0,
        w_day: 0,
        w_hour: 0,
        w_minute: 0,
        w_second: 0,
        w_milliseconds: 0,
    };
    unsafe { GetLocalTime(&mut st) };
    // w_day_of_week is Sun=0..Sat=6; convert to Mon=0..Sun=6.
    let weekday_mon0 = if st.w_day_of_week == 0 { 6 } else { st.w_day_of_week as u32 - 1 };
    LocalTimeInfo {
        hour: st.w_hour as u32,
        minute: st.w_minute as u32,
        second: st.w_second as u32,
        weekday_mon0,
    }
}

fn utc_time_info() -> LocalTimeInfo {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day_secs = secs % 86400;
    let hour = (day_secs / 3600) as u32;
    let minute = ((day_secs % 3600) / 60) as u32;
    let second = (day_secs % 60) as u32;
    // Unix epoch was Thursday → days since epoch + 3 gives Mon=0.
    let days = secs / 86400;
    let weekday_mon0 = ((days + 3) % 7) as u32;
    LocalTimeInfo { hour, minute, second, weekday_mon0 }
}

fn segment_active_now(segment: &DerivedSegment, info: &LocalTimeInfo, now: u64) -> bool {
    // Windowing by activeFrom / activeUntil (used for one-shot schedules).
    if let Some(active_from) = segment.active_from_timestamp_ms {
        if now < active_from {
            return false;
        }
    }
    if let Some(active_until) = segment.active_until_timestamp_ms {
        if now > active_until {
            return false;
        }
    }

    let current_min = info.hour * 60 + info.minute;
    let start_min = segment.start_hour * 60 + segment.start_minute;
    let end_min = segment.end_hour * 60 + segment.end_minute;
    let weekday = info.weekday_mon0;

    // All-day segment: start == end → active all day on listed days.
    if start_min == end_min {
        return segment.days.contains(&weekday);
    }

    if start_min < end_min {
        if !segment.days.contains(&weekday) {
            return false;
        }
        current_min >= start_min && current_min < end_min
    } else {
        // Cross-midnight: segment starts today on `weekday` and continues
        // into the following day. Active if either:
        //  - today is a listed day and we're past start_min
        //  - yesterday (weekday - 1 mod 7) was a listed day and we're before end_min
        let today = segment.days.contains(&weekday) && current_min >= start_min;
        let yesterday = (weekday + 6) % 7;
        let spillover = segment.days.contains(&yesterday) && current_min < end_min;
        today || spillover
    }
}

fn schedule_is_active_now(schedule: &DerivedSchedule, now: u64, info: &LocalTimeInfo) -> bool {
    if schedule.is_paused {
        if schedule.pause_end_time.map_or(true, |pe| pe > now) {
            return false;
        }
    }
    // If this is a date-bound schedule, respect the end-of-day cutoff.
    if schedule.repeat_type.as_deref() == Some("date") {
        if let Some(_date_str) = &schedule.repeat_date {
            // Without chrono we only do a best-effort cutoff using activeUntil
            // fields on segments. The frontend is already authoritative about
            // not enqueueing stale entries; this is a safety belt.
        }
    }
    schedule.segments.iter().any(|s| segment_active_now(s, info, now))
}

fn normalize_domain(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    for prefix in ["https://", "http://"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.to_string();
        }
    }
    if let Some(slash) = s.find('/') {
        s.truncate(slash);
    }
    if s.is_empty() {
        return None;
    }
    if PROTECTED_DOMAINS.contains(&s.as_str()) {
        return None;
    }
    Some(s)
}

/// Enriched representation of a single active block "reason". The native
/// host emits a `Vec<ActiveBlockInfo>` alongside the flat domain list so the
/// browser extension's blocked-page can tell the user *which* blocklist
/// caught them and *how long* they're blocked for.
///
/// One blocklist can contribute multiple entries at once (e.g. a manual
/// "block now" in parallel with an active schedule window). The blocked
/// page picks the most relevant one for the URL it's redirecting — see
/// `background.js` in reddfocus-open-source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveBlockInfo {
    /// Blocklist ID this window is for (stable across renames).
    pub blocklist_id: String,
    /// Human-readable blocklist name ("No Twitter").
    pub name: String,
    /// Optional emoji prefix ("🐦").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Hex color (e.g. "#A0CED9") picked by the user for this blocklist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Sorted, deduped domain list this window contributes.
    pub domains: Vec<String>,
    /// "manual" for one-off blocks (ActiveBlock), "schedule" for schedule
    /// segments. Mostly for diagnostics.
    pub source: &'static str,
    /// Wall-clock end of this block window in Unix ms, or `None` for
    /// schedules with no bounded end (e.g. all-day segments whose end is
    /// the next local midnight — we still emit that, but a truly open-
    /// ended block would be `None`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ends_at: Option<u64>,
    /// When this block window became active (for manual blocks) or the
    /// schedule segment's start today (best effort). Mainly lets the
    /// blocked page compute "how long it's been active".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

/// Convert local wall-clock minutes to a Unix-ms timestamp, using the
/// current local time as an anchor. `minute_of_day` > 1440 means "tomorrow"
/// relative to the anchor. Minute precision only; good enough for a
/// countdown displayed to a human.
fn local_minute_to_unix_ms(now_ms: u64, info: &LocalTimeInfo, minute_of_day: u32) -> u64 {
    let cur_mins_today = info.hour * 60 + info.minute;
    let cur_secs_today = cur_mins_today as u64 * 60 + info.second as u64;
    let ms_within_second = now_ms % 1000;
    // The Unix-ms instant at "today 00:00 local":
    let local_midnight_ms = now_ms
        .saturating_sub(cur_secs_today * 1000)
        .saturating_sub(ms_within_second);
    local_midnight_ms + minute_of_day as u64 * 60_000
}

/// Given a schedule segment known to be active right now, compute the
/// Unix-ms timestamp at which it stops being active. For cross-midnight
/// segments this may be tomorrow; for all-day segments it's next local
/// midnight.
fn segment_ends_at(segment: &DerivedSegment, info: &LocalTimeInfo, now_ms: u64) -> u64 {
    let start_min = segment.start_hour * 60 + segment.start_minute;
    let end_min = segment.end_hour * 60 + segment.end_minute;

    if start_min == end_min {
        // All-day: ends at next local midnight (24*60 minutes from today 00:00).
        return local_minute_to_unix_ms(now_ms, info, 24 * 60);
    }

    if start_min < end_min {
        // Same-day window — ends today at `end_min`.
        return local_minute_to_unix_ms(now_ms, info, end_min);
    }

    // Cross-midnight: are we in the pre-midnight part or post-midnight spillover?
    let cur = info.hour * 60 + info.minute;
    if cur >= start_min {
        // We started today at `start_min`; ends tomorrow at `end_min`.
        local_minute_to_unix_ms(now_ms, info, end_min + 24 * 60)
    } else {
        // We're in the spillover from yesterday's window; ends today at `end_min`.
        local_minute_to_unix_ms(now_ms, info, end_min)
    }
}

/// Best-effort "when did this segment window begin?" timestamp in Unix ms.
/// Returns `None` for all-day segments (which conceptually "began" at
/// midnight but the distinction is rarely useful to the user).
fn segment_started_at(segment: &DerivedSegment, info: &LocalTimeInfo, now_ms: u64) -> Option<u64> {
    let start_min = segment.start_hour * 60 + segment.start_minute;
    let end_min = segment.end_hour * 60 + segment.end_minute;
    if start_min == end_min {
        return None;
    }
    if start_min < end_min {
        return Some(local_minute_to_unix_ms(now_ms, info, start_min));
    }
    // Cross-midnight.
    let cur = info.hour * 60 + info.minute;
    if cur >= start_min {
        Some(local_minute_to_unix_ms(now_ms, info, start_min))
    } else {
        // Spillover — segment started yesterday at `start_min`.
        Some(local_minute_to_unix_ms(now_ms, info, start_min).saturating_sub(24 * 60 * 60_000))
    }
}

fn sorted_domains_for(blocklist: &DerivedBlocklist) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for domain in &blocklist.websites {
        if let Some(d) = normalize_domain(domain) {
            if seen.insert(d.clone()) {
                out.push(d);
            }
        }
    }
    out.sort();
    out
}

/// Compute one `ActiveBlockInfo` per active block *reason*, carrying
/// enough metadata for the blocked-page to render a rich card. Windows
/// for the same blocklist from multiple reasons (e.g. two overlapping
/// schedule segments) are collapsed by picking the latest `ends_at` —
/// from the user's perspective that's "when you regain access".
pub fn derive_active_blocks(data: &DerivedAppData) -> Vec<ActiveBlockInfo> {
    let now = now_ms();
    let info = local_time_info();

    // Map: blocklist_id → (source, latest_ends_at, earliest_started_at)
    // We collapse to one entry per blocklist so the extension can show a
    // single card per active blocklist regardless of how many reasons
    // happen to overlap.
    use std::collections::BTreeMap;
    struct Agg {
        source: &'static str,
        ends_at: Option<u64>,
        started_at: Option<u64>,
    }
    let mut agg: BTreeMap<String, Agg> = BTreeMap::new();

    let merge = |agg: &mut BTreeMap<String, Agg>,
                 blocklist_id: &str,
                 source: &'static str,
                 ends_at: Option<u64>,
                 started_at: Option<u64>| {
        agg.entry(blocklist_id.to_string())
            .and_modify(|existing| {
                // Latest "regain access" wins.
                existing.ends_at = match (existing.ends_at, ends_at) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (None, _) | (_, None) => None,
                };
                // Earliest start wins.
                existing.started_at = match (existing.started_at, started_at) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (Some(a), None) => Some(a),
                    (None, b) => b,
                };
                // "manual" dominates "schedule" for labeling purposes —
                // a one-off block the user deliberately started is the
                // more salient reason.
                if source == "manual" {
                    existing.source = source;
                }
            })
            .or_insert(Agg { source, ends_at, started_at });
    };

    for ab in &data.active_blocks {
        if ab.is_paused && ab.pause_end_time.map_or(true, |pe| pe > now) {
            continue;
        }
        if ab.start_time <= now && ab.end_time > now {
            merge(
                &mut agg,
                &ab.blocklist_id,
                "manual",
                Some(ab.end_time),
                Some(ab.start_time),
            );
        }
    }

    for sch in &data.schedules {
        if !schedule_is_active_now(sch, now, &info) {
            continue;
        }
        for seg in &sch.segments {
            if segment_active_now(seg, &info, now) {
                merge(
                    &mut agg,
                    &sch.blocklist_id,
                    "schedule",
                    Some(segment_ends_at(seg, &info, now)),
                    segment_started_at(seg, &info, now),
                );
            }
        }
    }

    let mut out: Vec<ActiveBlockInfo> = Vec::new();
    for (blocklist_id, a) in agg {
        let Some(bl) = data.blocklists.iter().find(|b| b.id == blocklist_id) else {
            continue;
        };
        let domains = sorted_domains_for(bl);
        if domains.is_empty() {
            continue;
        }
        out.push(ActiveBlockInfo {
            blocklist_id: bl.id.clone(),
            name: if bl.name.is_empty() {
                "Blocklist".into()
            } else {
                bl.name.clone()
            },
            emoji: bl.emoji.clone().filter(|s| !s.is_empty()),
            color: bl.color.clone().filter(|s| !s.is_empty()),
            domains,
            source: a.source,
            ends_at: a.ends_at,
            started_at: a.started_at,
        });
    }
    // Stable ordering: earliest-ending first so the extension can pick the
    // "soonest to release you" card if a URL sits in multiple lists.
    out.sort_by(|a, b| match (a.ends_at, b.ends_at) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.name.cmp(&b.name),
    });
    out
}

/// Compute the deduplicated, sorted, protection-filtered list of currently
/// blocked domains.
pub fn derive_active_domains(data: &DerivedAppData) -> Vec<String> {
    let now = now_ms();
    let info = local_time_info();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    // Helper to push all websites of a blocklist id.
    let push_blocklist_domains = |blocklist_id: &str,
                                  seen: &mut HashSet<String>,
                                  out: &mut Vec<String>| {
        if let Some(bl) = data.blocklists.iter().find(|b| b.id == blocklist_id) {
            for domain in &bl.websites {
                if let Some(d) = normalize_domain(domain) {
                    if seen.insert(d.clone()) {
                        out.push(d);
                    }
                }
            }
        }
    };

    for ab in &data.active_blocks {
        if ab.is_paused {
            // Only treat pause as active when pauseEndTime is still in the future.
            if ab.pause_end_time.map_or(true, |pe| pe > now) {
                continue;
            }
        }
        if ab.start_time <= now && ab.end_time > now {
            push_blocklist_domains(&ab.blocklist_id, &mut seen, &mut out);
        }
    }

    for sch in &data.schedules {
        if schedule_is_active_now(sch, now, &info) {
            push_blocklist_domains(&sch.blocklist_id, &mut seen, &mut out);
        }
    }

    out.sort();
    out
}

/// Read `redd-block-data.json` from the canonical path, falling back to legacy
/// per-user paths. Returns `None` if no file exists.
pub fn read_app_data() -> Option<(PathBuf, DerivedAppData)> {
    let path = resolve_data_path()?;
    let contents = fs::read_to_string(&path).ok()?;
    let parsed: DerivedAppData = serde_json::from_str(&contents).ok()?;
    Some((path, parsed))
}

/// Try to locate the active `redd-block-data.json`. Prefers the shared desktop
/// path; falls back to the per-user legacy locations.
pub fn resolve_data_path() -> Option<PathBuf> {
    let candidates = candidate_data_paths();
    // Prefer the first candidate that exists; callers can decide how to react
    // if none is found (native host returns an empty blocklist in that case).
    candidates.into_iter().find(|p| p.exists())
}

/// Every location we'll inspect for the data file. Used both to pick the
/// active one and to watch all of them in the native host (a migration might
/// flip which path is authoritative mid-session).
pub fn candidate_data_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // Shared canonical (helper-era) paths.
    #[cfg(target_os = "windows")]
    {
        let program_data = std::env::var("PROGRAMDATA").unwrap_or_else(|_| "C:\\ProgramData".to_string());
        out.push(PathBuf::from(&program_data).join("ReDD Block").join("redd-block-data.json"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        out.push(PathBuf::from("/var/lib/redd-block/redd-block-data.json"));
    }

    // Per-user app data directory (what Tauri's app_data_dir() resolves to).
    if let Some(data_dir) = dirs::data_dir() {
        for id in &["com.reddblock", "com.redd.block", "redd-block"] {
            out.push(data_dir.join(id).join("redd-block-data.json"));
        }
    }

    out
}

/// Return the first existing parent directory of the candidate paths that
/// still exists on disk — useful because `notify` requires watching a dir
/// that actually exists.
pub fn watch_parents() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in candidate_data_paths() {
        if let Some(parent) = p.parent() {
            if parent.exists() && seen.insert(parent.to_path_buf()) {
                out.push(parent.to_path_buf());
            }
        }
    }
    out
}

pub fn data_file_name() -> &'static str {
    "redd-block-data.json"
}

/// Convenience: read + derive in one call.
pub fn current_blocklist() -> Vec<String> {
    match read_app_data() {
        Some((_, data)) => derive_active_domains(&data),
        None => Vec::new(),
    }
}

/// Convenience: read + derive the rich active-block list in one call.
pub fn current_active_blocks() -> Vec<ActiveBlockInfo> {
    match read_app_data() {
        Some((_, data)) => derive_active_blocks(&data),
        None => Vec::new(),
    }
}

/// For diagnostics: returns the resolved data path and the derived domains.
pub fn current_blocklist_with_source() -> (Option<PathBuf>, Vec<String>) {
    match read_app_data() {
        Some((p, data)) => (Some(p), derive_active_domains(&data)),
        None => (None, Vec::new()),
    }
}

/// Helper tests (schedule corners) live under this module so they run as part
/// of `cargo test` in the Tauri crate.
#[cfg(test)]
mod tests {
    use super::*;

    fn info(hour: u32, minute: u32, wd: u32) -> LocalTimeInfo {
        LocalTimeInfo { hour, minute, second: 0, weekday_mon0: wd }
    }

    #[test]
    fn same_day_segment_matches_only_during_window() {
        let seg = DerivedSegment {
            start_hour: 9,
            start_minute: 0,
            end_hour: 17,
            end_minute: 0,
            days: vec![0, 1, 2, 3, 4],
            ..Default::default()
        };
        assert!(segment_active_now(&seg, &info(10, 0, 0), 0));
        assert!(!segment_active_now(&seg, &info(17, 0, 0), 0));
        assert!(!segment_active_now(&seg, &info(8, 59, 5), 0));
    }

    #[test]
    fn cross_midnight_segment_wraps() {
        let seg = DerivedSegment {
            start_hour: 22,
            start_minute: 0,
            end_hour: 6,
            end_minute: 0,
            days: vec![0],
            ..Default::default()
        };
        // Monday 23:00 — in window.
        assert!(segment_active_now(&seg, &info(23, 0, 0), 0));
        // Tuesday 05:00 — spillover, still in window.
        assert!(segment_active_now(&seg, &info(5, 0, 1), 0));
        // Tuesday 06:00 — past window end.
        assert!(!segment_active_now(&seg, &info(6, 0, 1), 0));
    }

    #[test]
    fn all_day_segment_matches_listed_day() {
        let seg = DerivedSegment {
            start_hour: 0,
            start_minute: 0,
            end_hour: 0,
            end_minute: 0,
            days: vec![5], // Saturday
            ..Default::default()
        };
        assert!(segment_active_now(&seg, &info(0, 0, 5), 0));
        assert!(segment_active_now(&seg, &info(23, 59, 5), 0));
        assert!(!segment_active_now(&seg, &info(12, 0, 4), 0));
    }

    #[test]
    fn protected_domains_are_stripped() {
        assert!(normalize_domain("localhost").is_none());
        assert_eq!(normalize_domain("https://REDDIT.COM/foo").as_deref(), Some("reddit.com"));
    }
}

impl Default for DerivedSegment {
    fn default() -> Self {
        Self {
            start_hour: 0,
            start_minute: 0,
            end_hour: 0,
            end_minute: 0,
            days: Vec::new(),
            active_from_timestamp_ms: None,
            active_until_timestamp_ms: None,
        }
    }
}
