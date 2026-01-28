# ReDD Block

Block distracting websites and apps with scheduled or one-off blocks. Stay focused on what matters.

Built with [Tauri 2](https://tauri.app/) for a lightweight, native experience.

## Features

- **Website Blocking** — System-level hosts file blocking works across all browsers
- **App Blocking** — Automatically hides distracting apps when launched (macOS)
- **Flexible Blocklists** — Create multiple lists with custom names, colors, and emojis
- **Scheduled Blocks** — Set recurring blocks on specific days/times (e.g., block social media Mon-Fri 9am-5pm)
- **One-Off Blocks** — Quick blocks for immediate focus sessions
- **Visual Calendar** — See all your scheduled and active blocks on an interactive weekly timeline
- **Override Protection** — Configurable typing challenges prevent impulsive unblocking
- **Background Operation** — Blocks continue even when the app is closed
- **Dark Mode** — Toggle between light and dark themes

## Local Development

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Tauri CLI](https://tauri.app/start/prerequisites/)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/ulyngs/redd-block.git
cd redd-block

# Install dependencies
npm install

# Run in development mode
npm run dev
```

The app will open automatically. Hot-reloading is enabled for both frontend (Vite) and backend (Tauri).

### Building

```bash
# Build for macOS (DMG + App bundle)
npm run tauri build

# Build universal binary (Intel + Apple Silicon)
npm run tauri build -- --target universal-apple-darwin
```

## How It Works

### Website Blocking
A privileged helper daemon modifies `/etc/hosts` to redirect blocked domains to `0.0.0.0`. Blocks persist across app restarts and work in all browsers.

### App Blocking (macOS)
Uses AppleScript to monitor running apps and hide blocked ones when launched.

### Scheduling
Schedules are stored with segments (time ranges) and days. A background interval checks if any schedule segment is currently active and updates the hosts file accordingly.

### Helper Daemon
Runs with root privileges to manage hosts file changes. After initial setup (one-time password), blocks start instantly without prompts.

## Project Structure

```
redd-block/
├── src/                      # Frontend (HTML/JS/CSS)
│   ├── index.html            # Main app layout
│   ├── app.js                # App logic & UI
│   └── styles.css            # Styling
├── src-tauri/                # Tauri backend (Rust)
│   ├── src/
│   │   ├── lib.rs            # App setup & window config
│   │   └── commands/         # IPC commands
│   │       ├── helper.rs     # Helper daemon communication
│   │       ├── watcher.rs    # App blocking process watcher
│   │       └── data.rs       # Data persistence
│   └── tauri.conf.json       # Tauri configuration
└── helper-daemon/            # Privileged helper (Rust)
    └── src/main.rs           # Hosts file management
```

## Data Storage

### User Data
- **macOS**: `~/Library/Application Support/ReddBlock/redd-block-data.json`
- **Windows**: `%AppData%/ReddBlock/redd-block-data.json`

Contains blocklists, schedules, active blocks, and settings.

### Helper State
- **macOS**: `/var/lib/redd-block/helper-state.json`
- **Windows**: `C:\ProgramData\ReDD Block\helper-state.json`

Tracks blocking state so blocks persist across app restarts.

### Uninstall Behavior

**Important**: ReDD Block installs a privileged helper daemon that modifies your system's hosts file. When uninstalling, this helper must be properly stopped and the hosts file restored.

#### Recommended Uninstall Process

**macOS:**
1. Run the uninstall script to remove the helper daemon and restore your hosts file:
   ```bash
   sudo bash scripts/uninstall-mac.sh
   ```
2. Move `ReDD Block.app` from `/Applications` to Trash
3. (Optional) Remove user data:
   ```bash
   rm -rf ~/Library/Application\ Support/ReddBlock
   ```

**Windows:**
1. Run the uninstall script as Administrator to remove the helper and restore your hosts file:
   ```powershell
   # Right-click PowerShell → Run as Administrator
   .\scripts\uninstall-windows.ps1
   ```
2. Uninstall via Windows Settings: `Settings > Apps > ReDD Block > Uninstall`
3. (Optional) Remove user data from `%AppData%\ReddBlock`

#### What Gets Cleaned Up

The uninstall scripts ensure:
- ✅ **Helper daemon/service is stopped and removed** (launchd on macOS, scheduled task on Windows)
- ✅ **Original hosts file is restored from backup** (created automatically on first block)
- ✅ **All ReDD Block entries removed from hosts file**
- ✅ **DNS cache is flushed** to apply changes immediately
- ✅ **Backup and state files are deleted**

User data (blocklists, schedules, settings) is preserved by default for reinstallation. Delete manually if desired.

#### Backup File Persistence

The hosts file backup (`hosts.redd-backup`) is created once on first use and **persists across reinstalls**. This protects against:
- Failed uninstall attempts
- Helper daemon crashes
- Unexpected system reboots

If uninstallation fails, the backup file remains and can be manually restored:
```bash
# macOS
sudo cp /etc/hosts.redd-backup /etc/hosts

# Windows (as Administrator)
Copy-Item "$env:SystemRoot\System32\drivers\etc\hosts.redd-backup" "$env:SystemRoot\System32\drivers\etc\hosts"
```

## Requirements

- **macOS**: 11+ (Big Sur or later)
- **Windows**: Coming soon
- **Linux**: Coming soon

## License

CC-BY-NC-ND-3.0

---

Made with ♥ by [reddfocus.org](https://reddfocus.org)
