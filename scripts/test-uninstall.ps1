# Test script for uninstallation logic
# This simulates the app being uninstalled by creating/deleting the expected paths

$ErrorActionPreference = "Stop"

Write-Host "=== ReDD Block Uninstallation Test ===" -ForegroundColor Cyan

# Determine which path to use (LOCALAPPDATA is easier for testing)
$localAppData = $env:LOCALAPPDATA
$testPath = Join-Path $localAppData "Programs\redd-block"
$testExe = Join-Path $testPath "ReDD Block.exe"

Write-Host "`nTest path: $testExe" -ForegroundColor Yellow

# Create directory if it doesn't exist
if (-not (Test-Path $testPath)) {
    Write-Host "Creating test directory..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $testPath -Force | Out-Null
}

# Check if file exists
if (Test-Path $testExe) {
    Write-Host "Test file already exists. Delete it to simulate uninstallation." -ForegroundColor Green
    Write-Host "`nTo simulate uninstallation, run:" -ForegroundColor Cyan
    Write-Host "  Remove-Item '$testExe' -Force" -ForegroundColor White
    Write-Host "`nThen restart the helper:" -ForegroundColor Cyan
    Write-Host "  schtasks /Run /TN 'ReDD Block Helper'" -ForegroundColor White
} else {
    Write-Host "Creating dummy test file..." -ForegroundColor Yellow
    # Create an empty file (or copy your dev exe if you want)
    New-Item -ItemType File -Path $testExe -Force | Out-Null
    Write-Host "Test file created. Helper should detect app exists." -ForegroundColor Green
    Write-Host "`nTo test uninstallation:" -ForegroundColor Cyan
    Write-Host "  1. Start a block (optional, to test with active blocks)" -ForegroundColor White
    Write-Host "  2. Delete the test file: Remove-Item '$testExe' -Force" -ForegroundColor White
    Write-Host "  3. Restart helper: schtasks /Run /TN 'ReDD Block Helper'" -ForegroundColor White
    Write-Host "  4. Watch the hosts file and helper logs" -ForegroundColor White
}

Write-Host "`n=== Helper Status ===" -ForegroundColor Cyan
$task = schtasks /Query /TN "ReDD Block Helper" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Helper task exists and is configured" -ForegroundColor Green
    Write-Host $task
} else {
    Write-Host "Helper task not found. Install it first through the app." -ForegroundColor Red
}

Write-Host "`n=== Current Settings ===" -ForegroundColor Cyan
$settingsPath = Join-Path $env:APPDATA "com.redd-focus.block\data.json"
if (Test-Path $settingsPath) {
    $settings = Get-Content $settingsPath | ConvertFrom-Json
    $keepBlocking = $settings.settings.keepBlockingOnUninstall
    Write-Host "keepBlockingOnUninstall: $keepBlocking" -ForegroundColor $(if ($keepBlocking) { "Yellow" } else { "Green" })
} else {
    Write-Host "Settings file not found (defaults to true)" -ForegroundColor Yellow
}

Write-Host "`n=== Hosts File Location ===" -ForegroundColor Cyan
Write-Host "C:\Windows\System32\drivers\etc\hosts" -ForegroundColor White
Write-Host "Backup: C:\Windows\System32\drivers\etc\hosts.redd-backup" -ForegroundColor White
