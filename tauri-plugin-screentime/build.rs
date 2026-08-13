const COMMANDS: &[&str] = &[
    "request_authorization",
    "check_authorization",
    "block_websites",
    "unblock_websites",
    "block_apps",
    "unblock_apps",
    "refresh_activity_tokens",
    "screentime_start_block",
    "screentime_clear_block",
    "schedule_block",
    "set_schedules",
    "unschedule_block",
    "register_one_off_activity",
    "set_resume_payload",
    "set_block_end_state",
    "show_activity_picker",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
