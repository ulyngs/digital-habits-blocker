# Uninstall script for ReDD Block on Windows
# This script removes the helper daemon and restores the hosts file
# Run this script with Administrator privileges

param(
    [switch]$Force
)

# Ensure running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "=========================================="
    Write-Host "ReDD Block Uninstaller"
    Write-Host "=========================================="
    Write-Host ""
    Write-Host "ERROR: This script requires Administrator privileges." -ForegroundColor Red
    Write-Host "Please run this script from an elevated PowerShell prompt:" -ForegroundColor Yellow
    Write-Host "  1. Right-click PowerShell" -ForegroundColor Cyan
    Write-Host "  2. Select 'Run as Administrator'" -ForegroundColor Cyan
    Write-Host "  3. Run this script again" -ForegroundColor Cyan
    Write-Host ""
    pause
    exit 1
}

Write-Host "=========================================="
Write-Host "ReDD Block Uninstaller"
Write-Host "=========================================="
Write-Host ""

# Define paths
$TaskName = "ReDD Block Helper"
$ProgramData = $env:ProgramData
$HelperDir = Join-Path $ProgramData "ReDD Block"
$HelperExe = Join-Path $HelperDir "redd-block-helper.exe"
$StateFile = Join-Path $HelperDir "helper-state.json"
$HostsPath = "$env:SystemRoot\System32\drivers\etc\hosts"
$BackupPath = "$env:SystemRoot\System32\drivers\etc\hosts.redd-backup"

# Step 1: Restore hosts file
Write-Host "Step 1: Restoring hosts file from backup..."

if (Test-Path $BackupPath) {
    try {
        Copy-Item -Path $BackupPath -Destination $HostsPath -Force
        Write-Host "[OK] Hosts file restored from backup" -ForegroundColor Green
        
        # Flush DNS cache
        ipconfig /flushdns | Out-Null
        Write-Host "[OK] DNS cache flushed" -ForegroundColor Green
    }
    catch {
        Write-Host "[ERROR] Failed to restore hosts file: $_" -ForegroundColor Red
        if (-not $Force) {
            Write-Host "Use -Force to continue despite errors" -ForegroundColor Yellow
            exit 1
        }
    }
}
else {
    Write-Host "[WARNING] No backup file found at $BackupPath" -ForegroundColor Yellow
    Write-Host "          Removing any ReDD Block entries from hosts file..." -ForegroundColor Yellow
    
    # Remove entries between markers
    try {
        $hostsContent = Get-Content $HostsPath -Raw
        if ($hostsContent -match '# BEGIN REDD BLOCK') {
            $pattern = '(?s)# BEGIN REDD BLOCK.*?# END REDD BLOCK\r?\n?'
            $cleanedContent = $hostsContent -replace $pattern, ''
            Set-Content -Path $HostsPath -Value $cleanedContent -NoNewline -Force
            Write-Host "[OK] ReDD Block entries removed from hosts file" -ForegroundColor Green
            
            # Flush DNS cache
            ipconfig /flushdns | Out-Null
            Write-Host "[OK] DNS cache flushed" -ForegroundColor Green
        }
        else {
            Write-Host "          No ReDD Block entries found in hosts file"
        }
    }
    catch {
        Write-Host "[ERROR] Failed to clean hosts file: $_" -ForegroundColor Red
        if (-not $Force) {
            Write-Host "Use -Force to continue despite errors" -ForegroundColor Yellow
            exit 1
        }
    }
}

Write-Host ""
Write-Host "Step 2: Stopping and removing helper daemon..."

# Stop the scheduled task
try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
        Write-Host "[OK] Helper task stopped" -ForegroundColor Green
    }
    else {
        Write-Host "[INFO] Scheduled task not found (may already be removed)"
    }
}
catch {
    Write-Host "[WARNING] Could not stop helper task: $_" -ForegroundColor Yellow
}

# Delete the scheduled task
try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[OK] Scheduled task removed" -ForegroundColor Green
    }
}
catch {
    Write-Host "[ERROR] Failed to remove scheduled task: $_" -ForegroundColor Red
    if (-not $Force) {
        Write-Host "Use -Force to continue despite errors" -ForegroundColor Yellow
        exit 1
    }
}

# Wait a moment for process to stop
Start-Sleep -Milliseconds 500

# Kill any running helper processes
try {
    $processes = Get-Process -Name "redd-block-helper" -ErrorAction SilentlyContinue
    if ($processes) {
        $processes | Stop-Process -Force
        Write-Host "[OK] Helper process stopped" -ForegroundColor Green
    }
}
catch {
    Write-Host "[WARNING] Could not stop helper process: $_" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Step 3: Cleaning up files and directories..."

# Remove helper directory
if (Test-Path $HelperDir) {
    try {
        Remove-Item -Path $HelperDir -Recurse -Force
        Write-Host "[OK] Helper directory removed" -ForegroundColor Green
    }
    catch {
        Write-Host "[ERROR] Failed to remove helper directory: $_" -ForegroundColor Red
        Write-Host "        You may need to manually delete: $HelperDir" -ForegroundColor Yellow
    }
}
else {
    Write-Host "[INFO] Helper directory not found at $HelperDir"
}

# Remove backup file
if (Test-Path $BackupPath) {
    try {
        Remove-Item -Path $BackupPath -Force
        Write-Host "[OK] Backup file removed" -ForegroundColor Green
    }
    catch {
        Write-Host "[WARNING] Could not remove backup file: $_" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=========================================="
Write-Host "[SUCCESS] Helper daemon uninstalled successfully" -ForegroundColor Green
Write-Host "=========================================="
Write-Host ""
Write-Host "Note: To remove the application itself, use Windows Settings:"
Write-Host "      Settings > Apps > ReDD Block > Uninstall"
Write-Host ""
Write-Host "To also remove user data (blocklists, schedules, settings):" -ForegroundColor Cyan
Write-Host "  Remove-Item -Path `"$env:AppData\ReddBlock`" -Recurse -Force" -ForegroundColor Gray
Write-Host ""
pause
