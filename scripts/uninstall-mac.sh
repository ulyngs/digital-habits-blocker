#!/bin/bash
# Uninstall script for ReDD Block on macOS
# This script removes the helper daemon and restores the hosts file

# Don't use set -e to allow graceful error handling throughout the script

echo "=========================================="
echo "ReDD Block Uninstaller"
echo "=========================================="
echo ""

# Define paths
PLIST_PATH="/Library/LaunchDaemons/com.redd.block.helper.plist"
HELPER_PATH="/usr/local/bin/redd-block-helper"
SOCKET_PATH="/tmp/redd-block-helper.sock"
BACKUP_PATH="/etc/hosts.redd-backup"
HOSTS_PATH="/etc/hosts"
STATE_DIR="/var/lib/redd-block"

# Check if running as root (needed for unload and file operations)
if [ "$EUID" -ne 0 ]; then 
    echo "This script requires administrator privileges."
    echo "You may be prompted for your password."
    echo ""
    
    # Re-run script with sudo
    exec sudo "$0" "$@"
    exit $?
fi

echo "Step 1: Restoring hosts file from backup..."
if [ -f "$BACKUP_PATH" ]; then
    cp "$BACKUP_PATH" "$HOSTS_PATH"
    echo "✓ Hosts file restored from backup"
    
    # Flush DNS cache
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
    echo "✓ DNS cache flushed"
else
    echo "⚠ No backup file found at $BACKUP_PATH"
    echo "  Removing any ReDD Block entries from hosts file..."
    
    # Remove entries between markers
    if grep -q "# BEGIN REDD BLOCK" "$HOSTS_PATH" 2>/dev/null; then
        sed -i.tmp '/# BEGIN REDD BLOCK/,/# END REDD BLOCK/d' "$HOSTS_PATH"
        rm -f "$HOSTS_PATH.tmp"
        echo "✓ ReDD Block entries removed from hosts file"
        
        # Flush DNS cache
        dscacheutil -flushcache 2>/dev/null || true
        killall -HUP mDNSResponder 2>/dev/null || true
        echo "✓ DNS cache flushed"
    else
        echo "  No ReDD Block entries found in hosts file"
    fi
fi

echo ""
echo "Step 2: Stopping and removing helper daemon..."

# Unload the daemon if it's loaded
if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "✓ Helper daemon stopped"
    
    # Remove the plist file
    rm -f "$PLIST_PATH"
    echo "✓ Launch daemon configuration removed"
else
    echo "⚠ Launch daemon configuration not found"
fi

# Remove the helper binary
if [ -f "$HELPER_PATH" ]; then
    rm -f "$HELPER_PATH"
    echo "✓ Helper binary removed"
else
    echo "⚠ Helper binary not found at $HELPER_PATH"
fi

echo ""
echo "Step 3: Cleaning up state files and backups..."

# Remove socket file
if [ -e "$SOCKET_PATH" ]; then
    rm -f "$SOCKET_PATH"
    echo "✓ Socket file removed"
fi

# Remove state directory
if [ -d "$STATE_DIR" ]; then
    rm -rf "$STATE_DIR"
    echo "✓ State directory removed"
fi

# Remove backup file
if [ -f "$BACKUP_PATH" ]; then
    rm -f "$BACKUP_PATH"
    echo "✓ Backup file removed"
fi

# Remove log file
if [ -f "/var/log/redd-block-helper.log" ]; then
    rm -f "/var/log/redd-block-helper.log"
    echo "✓ Log file removed"
fi

echo ""
echo "=========================================="
echo "✓ Helper daemon uninstalled successfully"
echo "=========================================="
echo ""
echo "Note: To remove the application itself, drag ReDD Block.app"
echo "      from /Applications to the Trash."
echo ""
echo "To also remove user data (blocklists, schedules, settings):"
echo "  rm -rf ~/Library/Application\\ Support/ReddBlock"
echo ""
