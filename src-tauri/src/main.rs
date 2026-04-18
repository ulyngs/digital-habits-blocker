// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Native messaging host mode: when the browser spawns this binary via
    // the extension's native-messaging manifest (see `commands/extension.rs`
    // for how the manifest's `path` shim execs us), we must not boot the
    // Tauri UI — the browser owns our stdio and expects the Chrome native
    // messaging framing instead. Branch before Tauri touches anything.
    if redd_block_lib::is_native_host_invocation() {
        std::process::exit(match redd_block_lib::run_native_host() {
            Ok(()) => 0,
            Err(_) => 1,
        });
    }
    redd_block_lib::run();
}
