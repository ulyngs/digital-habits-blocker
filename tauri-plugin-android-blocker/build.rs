const COMMANDS: &[&str] = &[
    "check_blocker_permissions",
    "open_accessibility_settings",
    "set_schedules",
    "start_manual_block",
    "stop_manual_block",
    "temporary_unlock",
    "get_blocking_state",
    "read_native_schedules",
    "get_installed_apps",
    "set_event_handler",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
