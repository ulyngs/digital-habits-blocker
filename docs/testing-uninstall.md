# ReDD Block Uninstallation Testing Pipeline - Windows

## Prerequisites

Before starting any tests, ensure you have:

1. **Windows machine with admin access** - Required for UAC prompts and scheduled task management
2. **ReDD Block helper daemon built with 15-second check interval** - Modified from default 5 minutes for faster testing
   - Location: `helper-daemon/src/main.rs` line 558 should be: `thread::sleep(std::time::Duration::from_secs(15));`
   - Rebuild after modification: `cd helper-daemon && cargo build --release`
   - Copy to install location: Copy `helper-daemon/target/release/redd-block-helper.exe` to `%PROGRAMDATA%\ReDD Block\redd-block-helper.exe`
3. **PowerShell access** - All commands are PowerShell
4. **Test script available** - `scripts/test-uninstall.ps1` should exist in project root
5. **Dev environment ready** - Node.js, Rust, Tauri CLI installed

---

## What We Are Testing

This test suite validates the uninstallation logic of the ReDD Block helper daemon. The helper checks every 15 seconds whether the main application still exists. When the app is deleted, the helper's behavior depends on:

1. **Active block state** - Is there currently a block running?
2. **User setting** - Is `keepBlockingOnUninstall` enabled or disabled?

### Test Scenarios

**Scenario A: No Blocks Running**
- **Condition:** App deleted, no active blocks
- **Expected:** Helper should restore hosts file, delete state file, remove scheduled task, and exit

**Scenario B: Block Active + Setting ON (Default)**
- **Condition:** App deleted, block is active, `keepBlockingOnUninstall = true`
- **Expected:** Helper should keep running and maintain the block until it expires

**Scenario C: Block Active + Setting OFF**
- **Condition:** App deleted, block is active, `keepBlockingOnUninstall = false`
- **Expected:** Helper should restore hosts file, delete state file, remove scheduled task, and exit (even with active block)

**Scenario D: Manual Helper Removal**
- **Condition:** User clicks "Remove Helper Now" button in Settings
- **Expected:** Helper should immediately restore hosts file, delete state file, remove scheduled task, and exit

---

## Test Setup (Run Before Every Scenario)

**IMPORTANT:** Perform these steps before testing each scenario to ensure a clean state.

### Step 1: Kill Everything and Start Clean

**Purpose:** Stop all redd-block processes to ensure a clean test environment.

**Command:**
```powershell
Get-Process | Where-Object {$_.ProcessName -like "*redd-block*"} | Stop-Process -Force -ErrorAction SilentlyContinue
```

**Verification:**
```powershell
Get-Process | Where-Object {$_.ProcessName -like "*redd-block*"}
```

**Expected Output:** No output (no processes found)

**If processes still exist:** Open PowerShell as Administrator and try again, or manually kill the process by PID.

---

### Step 2: Set Up Test File

**Purpose:** Create a dummy file at the expected installation path so the helper detects the app as installed.

**Command:**
```powershell
cd C:\Users\tctia\redd_local\Apps\redd-block
.\scripts\test-uninstall.ps1
```

**Verification:**
```powershell
Test-Path 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe'
```

**Expected Output:** `True` (file exists)

**Note:** Adjust the path `C:\Users\tctia\redd_local\Apps\redd-block` to match your project location.

---

### Step 3: Start Dev App

**Purpose:** Start the Tauri dev app so you can interact with it and install the helper.

**Command:**
```powershell
cd C:\Users\tctia\redd_local\Apps\redd-block
npm run tauri dev
```

**Expected Output:** Dev app window opens

**Note:** Keep this terminal window open - the app runs here. You'll need a separate PowerShell window for commands.

---

### Step 4: Install Helper Properly

**Purpose:** Install the helper daemon as a Windows scheduled task.

**Actions in App:**
1. Create a blocklist (if you don't have one)
   - Click "Create Blocklist" or select existing
   - Add at least one website (e.g., `example.com`)
2. Start a block
   - Select the blocklist
   - Click "Start Block" button
3. When prompted, click "Proceed" to install the helper
4. Approve the UAC prompt (Windows will ask for admin permission)

**Verification:**
```powershell
schtasks /Query /TN "ReDD Block Helper"
```

**Expected Output:** Task exists and shows status (e.g., "Running" or "Ready")

**If installation fails:** Check UAC prompt was approved, verify helper executable exists at `%PROGRAMDATA%\ReDD Block\redd-block-helper.exe`

---

### Step 5: Verify Helper is Running

**Purpose:** Confirm the helper daemon process is running and listening for connections.

**Commands:**
```powershell
# Check if helper process exists
Get-Process -Name "redd-block-helper" -ErrorAction SilentlyContinue

# Check if helper is listening on port 62222
netstat -ano | findstr :62222
```

**Expected Output:**
- Process shows `redd-block-helper` with a PID (e.g., `Handles NPM(K) PM(K) WS(K) CPU(s) Id SI ProcessName` followed by process details)
- Port 62222 shows `LISTENING` status with the same PID

**If helper not running:** Check scheduled task status, verify helper executable exists, check Windows Event Viewer for errors

---

### Step 6: Monitor Hosts File in Real-Time (Optional but Recommended)

**Purpose:** Watch the hosts file for changes during testing to see when blocks are added/removed.

**Command (Run in PowerShell as Administrator):**
```powershell
# Run this in PowerShell (as Administrator)
while ($true) {
    Clear-Host
    Write-Host "=== Hosts File - $(Get-Date -Format 'HH:mm:ss') ===" -ForegroundColor Green
    Get-Content C:\Windows\System32\drivers\etc\hosts
    Start-Sleep -Seconds 2
}
```

**What this does:** 
- Clears the screen every 2 seconds
- Shows current time
- Displays the full hosts file contents
- Updates every 2 seconds so you can see changes in real-time

**To stop:** Press `Ctrl+C`

**Note:** Keep this running in a separate PowerShell window (as Administrator) while testing. You'll see when redd-block entries are added or removed.

---

## Test Scenarios

### Scenario A: No Blocks Running

**Objective:** Verify helper cleans up completely when app is uninstalled with no active blocks.

**Prerequisites:** Complete Test Setup steps 1-5 above.

**Test Steps:**

1. **Ensure no active blocks**
   - In the app, verify no blocks are currently running
   - If a block is active, stop it or wait for it to expire

2. **Delete test file (simulates app uninstallation)**
   ```powershell
   Remove-Item 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe' -Force
   ```
   **What this does:** Deletes the dummy file so the helper thinks the app was uninstalled

3. **Verify test file is gone**
   ```powershell
   Test-Path 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe'
   ```
   **Expected Output:** `False` (file doesn't exist)

4. **Restart helper to trigger immediate check**
   ```powershell
   schtasks /Run /TN "ReDD Block Helper"
   ```
   **What this does:** Restarts the helper, which triggers an immediate check (then checks every 15 seconds)

5. **Wait for check**
   - Wait up to 15 seconds for the helper to detect the app is missing and perform cleanup

6. **Check if helper process still exists (should be gone)**
   ```powershell
   Get-Process -Name "redd-block-helper" -ErrorAction SilentlyContinue
   ```
   **Expected Output:** No output (process doesn't exist)

7. **Check if scheduled task still exists (should be gone)**
   ```powershell
   schtasks /Query /TN "ReDD Block Helper"
   ```
   **Expected Output:** Error message: `ERROR: The system cannot find the file specified.`

8. **Check if state file still exists (should be gone)**
   ```powershell
   Test-Path "C:\ProgramData\ReDD Block\helper-state.json"
   ```
   **Expected Output:** `False` (file doesn't exist)

9. **Check hosts file has no redd-block entries**
   ```powershell
   Get-Content C:\Windows\System32\drivers\etc\hosts | Select-String "REDD BLOCK"
   ```
   **Expected Output:** No output (no redd-block entries found)

**Pass Criteria:** All 4 checks (steps 6-9) must pass for scenario to be considered successful.

---

### Scenario B: Block Active + Setting ON (Default)

**Objective:** Verify helper keeps running when block is active and setting is ON (default behavior).

**Prerequisites:** Complete Test Setup steps 1-5 above.

**Test Steps:**

1. **Verify setting is ON (default)**
   - In the app: Go to Settings
   - Verify "Keep blocking on uninstall" is checked (default should be ON)
   - If it's not checked, check it

2. **Start a block in the app**
   - Create/select a blocklist
   - Click "Start Block" button
   - Ensure the block is active (you should see it's blocking - blocklist card shows "ACTIVE" or similar)

3. **Verify block is active**
   - In the app, confirm you see an active block
   - Try accessing a blocked site in browser - should be blocked

4. **Delete test file (simulates app uninstallation)**
   ```powershell
   Remove-Item 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe' -Force
   ```

5. **Verify test file is gone**
   ```powershell
   Test-Path 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe'
   ```
   **Expected Output:** `False` (file doesn't exist)

6. **Restart helper to trigger immediate check**
   ```powershell
   schtasks /Run /TN "ReDD Block Helper"
   ```

7. **Wait for check**
   - Wait up to 15 seconds for the helper to detect the app is missing

8. **Check if helper process still exists (should still be running)**
   ```powershell
   Get-Process -Name "redd-block-helper" -ErrorAction SilentlyContinue
   ```
   **Expected Output:** Process details showing `redd-block-helper` with PID

9. **Check if scheduled task still exists (should still exist)**
   ```powershell
   schtasks /Query /TN "ReDD Block Helper"
   ```
   **Expected Output:** Task exists and shows status "Running"

10. **Check if state file still exists (should still exist)**
    ```powershell
    Test-Path "C:\ProgramData\ReDD Block\helper-state.json"
    ```
    **Expected Output:** `True` (file still exists)

11. **Check hosts file still has block entries**
    ```powershell
    Get-Content C:\Windows\System32\drivers\etc\hosts | Select-String "REDD BLOCK"
    ```
    **Expected Output:** Shows redd-block entries (e.g., `# === BEGIN REDD BLOCK (reddfocus.org) ===`)

**Pass Criteria:** All 4 checks (steps 8-11) must pass - helper should keep running and block should remain active.

---

### Scenario C: Block Active + Setting OFF

**Objective:** Verify helper exits even with active block when setting is OFF.

**Prerequisites:** Complete Test Setup steps 1-5 above.

**Test Steps:**

1. **Set setting to OFF**
   - In the app: Go to Settings
   - **Uncheck** "Keep blocking on uninstall" (set it to OFF)
   - This is the key difference from Scenario B

2. **Start a block in the app**
   - Create/select a blocklist
   - Click "Start Block" button
   - Ensure the block is active (blocklist card shows "ACTIVE")

3. **Verify block is active**
   - In the app, confirm you see an active block
   - Try accessing a blocked site - should be blocked

4. **Delete test file (simulates app uninstallation)**
   ```powershell
   Remove-Item 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe' -Force
   ```

5. **Verify test file is gone**
   ```powershell
   Test-Path 'C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe'
   ```
   **Expected Output:** `False` (file doesn't exist)

6. **Restart helper to trigger immediate check**
   ```powershell
   schtasks /Run /TN "ReDD Block Helper"
   ```

7. **Wait for check**
   - Wait up to 15 seconds for the helper to detect the app is missing and perform cleanup

8. **Check if helper process still exists (should be gone)**
   ```powershell
   Get-Process -Name "redd-block-helper" -ErrorAction SilentlyContinue
   ```
   **Expected Output:** No output (process doesn't exist)

9. **Check if scheduled task still exists (should be gone)**
   ```powershell
   schtasks /Query /TN "ReDD Block Helper"
   ```
   **Expected Output:** Error message: `ERROR: The system cannot find the file specified.`

10. **Check if state file still exists (should be gone)**
    ```powershell
    Test-Path "C:\ProgramData\ReDD Block\helper-state.json"
    ```
    **Expected Output:** `False` (file doesn't exist)

11. **Check hosts file has no redd-block entries**
    ```powershell
    Get-Content C:\Windows\System32\drivers\etc\hosts | Select-String "REDD BLOCK"
    ```
    **Expected Output:** No output (no redd-block entries found - hosts should be restored)

**Pass Criteria:** All 4 checks (steps 8-11) must pass - helper should exit and hosts should be restored even with active block.

---

### Scenario D: Manual Helper Removal

**Objective:** Verify manual removal via "Remove Helper Now" button works correctly.

**Prerequisites:** Complete Test Setup steps 1-5 above.

**Test Steps:**

1. **Start a block in the app**
   - Create/select a blocklist
   - Click "Start Block" button
   - Ensure the block is active

2. **Verify block is active**
   - In the app, confirm you see an active block
   - Try accessing a blocked site - should be blocked

3. **Remove helper via app UI**
   - In the app: Go to Settings
   - Click "Remove Helper Now" button
   - Complete override challenge if prompted (type the challenge text)
   - Confirm removal when asked

4. **Check results immediately (no waiting needed)**
   ```powershell
   # Check if helper process still exists (should be gone)
   Get-Process -Name "redd-block-helper" -ErrorAction SilentlyContinue
   
   # Check if scheduled task still exists (should be gone)
   schtasks /Query /TN "ReDD Block Helper"
   
   # Check hosts file has no redd-block entries
   Get-Content C:\Windows\System32\drivers\etc\hosts | Select-String "REDD BLOCK"
   ```

5. **Verify helper process doesn't exist**
   **Expected Output:** No output (process doesn't exist)

6. **Verify scheduled task doesn't exist**
   **Expected Output:** Error message: `ERROR: The system cannot find the file specified.`

7. **Verify hosts file has no redd-block entries**
   **Expected Output:** No output (no redd-block entries found - hosts immediately restored)

**Pass Criteria:** All 3 checks (steps 5-7) must pass - helper should be removed immediately and hosts restored.

---

## Key File Locations

For reference during testing:

- **Test file:** `%LOCALAPPDATA%\Programs\redd-block\ReDD Block.exe`
- **Helper executable:** `%PROGRAMDATA%\ReDD Block\redd-block-helper.exe`
- **State file:** `%PROGRAMDATA%\ReDD Block\helper-state.json`
- **Hosts file:** `C:\Windows\System32\drivers\etc\hosts`
- **Hosts backup:** `C:\Windows\System32\drivers\etc\hosts.redd-backup`
- **Settings file:** `%APPDATA%\com.redd-focus.block\data.json`
- **Scheduled task name:** "ReDD Block Helper"

## Important Notes

- **Helper check interval:** Modified to 15 seconds for testing (normally 5 minutes)
- **Helper checks:** On startup, then every 15 seconds
- **Restarting helper:** `schtasks /Run /TN "ReDD Block Helper"` triggers immediate check
- **Helper privileges:** Runs with elevated privileges (Session ID 0 = SYSTEM)
- **Manual removal:** Works immediately via IPC command (no waiting)
- **Automatic detection:** May have delays up to check interval (15 seconds)

## Troubleshooting

**Helper won't install:**
- Verify UAC prompt was approved
- Check helper executable exists at install location
- Check Windows Event Viewer for errors

**Helper process won't stop:**
- Run PowerShell as Administrator
- Use `Stop-Process -Id <PID> -Force` with admin rights

**Test file path issues:**
- Adjust path `C:\Users\tctia\AppData\Local\Programs\redd-block\ReDD Block.exe` to match your username
- Or use `$env:LOCALAPPDATA\Programs\redd-block\ReDD Block.exe` in PowerShell

**Helper not detecting app missing:**
- Verify test file was actually deleted
- Check helper is using 15-second interval (not 300 seconds)
- Restart helper to trigger immediate check
