#[cfg(not(feature = "system-test"))]
use super::{canonical_data_path_static, per_user_data_path_static};
use super::{import_shared_data_into_per_user, per_user_data_path_from, DATA_FILE_NAME};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn temp_root(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("redd-block-import-{label}-{nanos}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Set an explicit mtime so the newer/older rule is exercised
/// deterministically instead of by sleeping past a filesystem's
/// timestamp granularity.
fn age(path: &Path, secs: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    let when = SystemTime::now() - Duration::from_secs(secs);
    file.set_times(fs::FileTimes::new().set_modified(when))
        .unwrap();
}

fn write_shared(dir: &Path, contents: &[u8]) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join(DATA_FILE_NAME);
    fs::write(&path, contents).unwrap();
    path
}

#[test]
fn imports_shared_data_when_per_user_is_missing() {
    let root = temp_root("missing");
    let shared = root.join("ProgramData");
    let src = write_shared(&shared, b"{\"from\":\"shared\"}");
    let dest = root.join("per-user").join(DATA_FILE_NAME);

    assert!(import_shared_data_into_per_user(
        &dest,
        std::slice::from_ref(&shared)
    ));

    assert_eq!(fs::read_to_string(&dest).unwrap(), "{\"from\":\"shared\"}");
    // Copy, never move: the other accounts on this machine still need it.
    assert!(src.exists());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn does_not_clobber_newer_per_user_data() {
    let root = temp_root("newer");
    let shared = root.join("ProgramData");
    let src = write_shared(&shared, b"stale-shared");
    let dest_dir = root.join("per-user");
    fs::create_dir_all(&dest_dir).unwrap();
    let dest = dest_dir.join(DATA_FILE_NAME);
    fs::write(&dest, b"fresh-per-user").unwrap();
    age(&src, 60);

    assert!(!import_shared_data_into_per_user(&dest, &[shared]));

    assert_eq!(fs::read_to_string(&dest).unwrap(), "fresh-per-user");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn imports_over_a_stale_per_user_file() {
    // The pre-v3 per-user -> shared migration copied without deleting, so
    // an upgrading Windows account can hold a per-user file frozen at
    // migration time next to the shared file it has been editing since.
    // Preferring the stale local copy would silently revert the blocklist.
    let root = temp_root("stale");
    let shared = root.join("ProgramData");
    write_shared(&shared, b"live-shared");
    let dest_dir = root.join("per-user");
    fs::create_dir_all(&dest_dir).unwrap();
    let dest = dest_dir.join(DATA_FILE_NAME);
    fs::write(&dest, b"stale-per-user").unwrap();
    age(&dest, 60);

    assert!(import_shared_data_into_per_user(&dest, &[shared]));

    assert_eq!(fs::read_to_string(&dest).unwrap(), "live-shared");
    let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn import_atomically_replaces_destination_without_copying_shared_permissions() {
    let root = temp_root("atomic");
    let shared = root.join("shared");
    let src = write_shared(&shared, b"live-shared");
    fs::set_permissions(&src, fs::Permissions::from_mode(0o777)).unwrap();

    let dest_dir = root.join("per-user");
    fs::create_dir_all(&dest_dir).unwrap();
    let dest = dest_dir.join(DATA_FILE_NAME);
    fs::write(&dest, b"stale-per-user").unwrap();
    age(&dest, 60);
    let original_inode = fs::metadata(&dest).unwrap().ino();

    assert!(import_shared_data_into_per_user(&dest, &[shared]));

    let imported = fs::metadata(&dest).unwrap();
    assert_ne!(
        imported.ino(),
        original_inode,
        "atomic replacement must swap in a new file"
    );
    assert_eq!(
        imported.permissions().mode() & 0o111,
        0,
        "import must not copy executable/shared source permissions"
    );
    assert_eq!(fs::read_to_string(&dest).unwrap(), "live-shared");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn prefers_the_first_shared_dir_that_has_the_file() {
    // Primary first, then the rebranded legacy ProgramData folders.
    let root = temp_root("order");
    let primary = root.join("Digital Habits Blocker");
    let legacy = root.join("ReDD Blocker");
    write_shared(&primary, b"from-primary");
    write_shared(&legacy, b"from-legacy");
    let dest = root.join("per-user").join(DATA_FILE_NAME);

    assert!(import_shared_data_into_per_user(&dest, &[primary, legacy]));

    assert_eq!(fs::read_to_string(&dest).unwrap(), "from-primary");
    let _ = fs::remove_dir_all(root);
}

#[test]
fn no_shared_data_creates_nothing() {
    let root = temp_root("absent");
    let dest = root.join("per-user").join(DATA_FILE_NAME);

    assert!(!import_shared_data_into_per_user(
        &dest,
        &[root.join("ProgramData")]
    ));

    assert!(!dest.exists());
    assert!(!dest.parent().unwrap().exists());
    let _ = fs::remove_dir_all(root);
}

#[cfg(not(feature = "system-test"))]
#[test]
fn resolver_never_returns_a_machine_wide_path() {
    // The regression guard for the shared-storage resolver: there is one
    // branch now, so two accounts can never select the same file.
    assert_eq!(canonical_data_path_static(), per_user_data_path_static());
}

#[test]
fn per_user_fallback_is_native_to_the_platform() {
    // Reachable whenever dirs::data_dir() returns None. It used to hand
    // back a macOS-shaped ~/Library path on every platform.
    let home = PathBuf::from("/testhome");
    let path = per_user_data_path_from(None, Some(home.clone()));

    assert!(path.starts_with(&home), "fallback must stay under $HOME");
    assert!(path.ends_with(DATA_FILE_NAME));

    let shape = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "macos")]
    assert!(
        shape.contains("Library/Application Support/com.reddblock"),
        "macOS fallback should be an Application Support path: {shape}"
    );
    #[cfg(not(target_os = "macos"))]
    assert!(
        !shape.contains("Library/Application Support"),
        "non-macOS fallback must not be macOS-shaped: {shape}"
    );
}
