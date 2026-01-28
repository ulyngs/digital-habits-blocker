# Uninstall Behavior Test Plan

## Test Scenarios

### Scenario 1: Normal Uninstall (macOS)
**Objective**: Verify helper daemon stops and hosts file is restored properly

**Steps**:
1. Install ReDD Block and the helper daemon
2. Create a blocklist and start a block
3. Verify hosts file contains ReDD Block entries:
   ```bash
   grep "BEGIN REDD BLOCK" /etc/hosts
   ```
4. Verify backup exists:
   ```bash
   ls -l /etc/hosts.redd-backup
   ```
5. Run uninstall script:
   ```bash
   sudo bash scripts/uninstall-mac.sh
   ```

**Expected Results**:
- ✅ Helper daemon is stopped (no longer in `launchctl list`)
- ✅ Hosts file restored from backup (no ReDD Block entries)
- ✅ DNS cache flushed
- ✅ launchd plist removed from `/Library/LaunchDaemons/`
- ✅ Helper binary removed from `/usr/local/bin/`
- ✅ State files removed from `/var/lib/redd-block/`
- ✅ Backup file removed

### Scenario 2: Normal Uninstall (Windows)
**Objective**: Verify helper service stops and hosts file is restored properly

**Steps**:
1. Install ReDD Block and the helper daemon
2. Create a blocklist and start a block
3. Verify hosts file contains ReDD Block entries:
   ```powershell
   Get-Content "$env:SystemRoot\System32\drivers\etc\hosts" | Select-String "REDD BLOCK"
   ```
4. Verify backup exists:
   ```powershell
   Test-Path "$env:SystemRoot\System32\drivers\etc\hosts.redd-backup"
   ```
5. Run uninstall script (as Administrator):
   ```powershell
   .\scripts\uninstall-windows.ps1
   ```

**Expected Results**:
- ✅ Helper task is stopped
- ✅ Scheduled task is removed
- ✅ Hosts file restored from backup (no ReDD Block entries)
- ✅ DNS cache flushed
- ✅ Helper binary removed from `C:\ProgramData\ReDD Block\`
- ✅ State files removed
- ✅ Backup file removed

### Scenario 3: Backup File Persistence (Failed Uninstall)
**Objective**: Verify backup persists if uninstall fails or is interrupted

**Steps**:
1. Install ReDD Block and helper daemon
2. Start a block to trigger backup creation
3. Verify backup exists (see commands above)
4. Simulate failed uninstall by killing uninstall script mid-way
5. Verify backup still exists
6. Manually restore hosts file:
   ```bash
   # macOS
   sudo cp /etc/hosts.redd-backup /etc/hosts
   
   # Windows
   Copy-Item "$env:SystemRoot\System32\drivers\etc\hosts.redd-backup" "$env:SystemRoot\System32\drivers\etc\hosts"
   ```

**Expected Results**:
- ✅ Backup file persists even after failed uninstall
- ✅ Manual restoration works correctly
- ✅ Blocked domains are no longer blocked after restore

### Scenario 4: Backup Persistence Across Reinstalls
**Objective**: Verify backup is not overwritten on reinstall

**Steps**:
1. Install ReDD Block and helper
2. Start a block (creates backup of clean hosts file)
3. Note backup file timestamp:
   ```bash
   # macOS
   stat -f "%Sm" /etc/hosts.redd-backup
   
   # Windows
   (Get-Item "$env:SystemRoot\System32\drivers\etc\hosts.redd-backup").LastWriteTime
   ```
4. Uninstall completely
5. Reinstall and start a new block
6. Check backup timestamp again

**Expected Results**:
- ✅ Backup timestamp is NOT updated (original backup preserved)
- ✅ Original clean hosts file is preserved in backup
- ✅ Code at line 160 in helper-daemon prevents overwriting: `if !backup_path.exists()`

### Scenario 5: Using Tauri Command for Uninstall
**Objective**: Verify the new `uninstall_helper()` command works

**Steps**:
1. Install ReDD Block with helper daemon
2. Start a block
3. Call `uninstall_helper()` from the app (via developer console):
   ```javascript
   await window.__TAURI__.invoke('uninstall_helper')
   ```

**Expected Results**:
- ✅ Hosts file restored successfully
- ✅ Helper daemon stopped and removed
- ✅ Function returns `{success: true}`
- ✅ All cleanup steps complete

### Scenario 6: Uninstall Without Active Block
**Objective**: Verify uninstall works even when no block is active

**Steps**:
1. Install ReDD Block with helper daemon
2. Do NOT start any block
3. Run uninstall script

**Expected Results**:
- ✅ Script completes successfully
- ✅ Helper daemon stopped and removed
- ✅ No errors about missing backup (script handles this case)
- ✅ Hosts file unchanged (no ReDD entries to remove)

## Verification Checklist

After each test, verify:
- [ ] Helper daemon/service is completely stopped
- [ ] Hosts file does not contain ReDD Block markers
- [ ] DNS cache has been flushed (test by visiting previously blocked domain)
- [ ] Helper binary files are removed
- [ ] State files are removed
- [ ] Backup file behavior matches expected scenario

## Known Limitations

1. **Manual steps still required**: Users must manually:
   - Move app to Trash (macOS) or uninstall via Settings (Windows)
   - Optionally delete user data directory

2. **Elevated privileges needed**: Both scripts require admin/root access

3. **No automatic uninstall hook**: Tauri doesn't provide built-in uninstall lifecycle hooks, so users must run scripts manually

## Code Evidence for Backup Persistence

From `helper-daemon/src/main.rs`:

```rust
/// Create a backup of the original hosts file if one doesn't exist
fn ensure_backup_exists() -> Result<(), String> {
    let backup_path = std::path::Path::new(HOSTS_BACKUP_PATH);
    
    if !backup_path.exists() {  // ← Key check: only creates if missing
        log("Creating backup of original hosts file");
        let content = read_hosts_file();
        fs::write(HOSTS_BACKUP_PATH, &content)...
    }
    Ok(())
}
```

This ensures:
- Backup created only on first block
- Never overwritten on subsequent blocks or reinstalls
- Persists through crashes, failed uninstalls, and reinstallations
