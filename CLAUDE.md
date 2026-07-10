# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ReDD Blocker is a cross-platform website/app blocker built as a **single Tauri v2 app** (Rust backend + HTML/JS/CSS frontend) targeting macOS 11+, Windows 10+, iOS 16+, and Android 8+ (API 26+). One frontend codebase (`src/`) drives all four platforms; enforcement differs per platform. There is **no** privileged helper daemon and **no** hosts-file writing — the app itself is the enforcement engine (v3 architecture).

The authoritative deep-dive is [architecture.md](architecture.md) — read it before touching enforcement code. It is versioned: **Part I = v3 (current, start here)**, Parts II/III are historical v2/v1 kept for migration context. Do not reason about current behavior from the historical parts.

## Commands

```bash
npm install                 # install deps (also provides local tauri CLI)
npm run dev                 # desktop dev (Vite + Tauri, hot-reload both ends)
npm run dev:ios             # iOS device via Xcode (⌘R to build; needs physical device)
npm run dev:android         # Android emulator/device
```

Builds (each maps to a script in `scripts/`):

```bash
npm run build:mac           # macOS universal .app
npm run build:mac-pkg       # signed/notarized .pkg installer
npm run build:mac-all       # .app + .pkg
npm run build:win           # Windows NSIS/MSI (x64 + ARM64)
npm run build:win-store     # Windows MSIX for Partner Center
npm run build:ios           # IPA for App Store
npm run build:android       # requires ANDROID_HOME/NDK_HOME/JAVA_HOME exported (see docs/android-build.md)
```

Version bumps span several files — always use `./scripts/bump-version.sh <version>` (updates `package.json`, `tauri.*.conf.json`, `Cargo.toml`).

### Testing

There is no CLI test runner. Tests run **inside the app** in dev mode via the dev console (details in [testing.md](testing.md)):

- **Tier 1 (logic, instant, no system changes):** start `npm run dev`, then `Cmd+Shift+T` (macOS) / `Ctrl+Shift+T` (Windows), or `runBlockingTests()` in the console. Cases live in `src/blocking-tests.js` (+ helpers in `src/test-utils.js`).
- **Tier 2 (integration, real command paths, safe `.invalid` domains):** `runIntegrationTests('core')` or `runIntegrationTests('full')` in the console. Cases in `src/integration-tests.js`. Note: Tier 2 asserts the Rust-derived `current_blocking` snapshot — it does **not** prove a browser actually redirects.
- **Website-enforcement correctness (Automation redirects, extension blocking) is validated manually** — see `scripts/manual-test-checklist.md`.

## Architecture essentials

### Single source of truth
Desktop website/app rules derive from one JSON file, `redd-block-data.json` (canonical `/var/lib/redd-block/...` on macOS, `%PROGRAMDATA%\ReDD Blocker\...` on Windows; per-user fallback until the shared dir is writable — path logic in `src-tauri/src/commands/data.rs`). The frontend writes it via `save_data`; every backend re-reads it. `native_host::derive_payload()` computes effective website rules: blocklist domains always block; when any allowlist source is active, policy is `allowed-union − blocked-union` (blocklist wins on overlap). iOS uses its own App Group store, not this file.

### Enforcement per platform
- **macOS websites:** Automation (Apple Events) in `src-tauri/src/web_automation.rs` — 1 s tick, redirects blocked tabs in Safari/Chrome/Brave/Edge to a bundled block page (`src-tauri/blocked/`). Firefox is the exception: it uses the extension + native-messaging host.
- **Windows websites:** ReDD Focus extension + native-messaging host (`native_host.rs`); the same binary runs as the host via `redd-block --native-host`.
- **Desktop apps (both OSes):** in-process poll-and-quit watcher, `src-tauri/src/app_watcher.rs` (1 s tick, PID state machine: warn → 30 s grace → polite quit → SIGKILL). Allow-mode inverts the target set.
- **Compliance enforcer** (`src-tauri/src/enforcer.rs`, 5 s tick): force-quits non-compliant *running* browsers during active website blocks — **opt-in only** (`settings.enforcementEnabled`, default off).
- **iOS:** Apple Screen Time via `tauri-plugin-screentime/` (Swift). No file, no extension, no process watching. Allow-mode uses `.all(except:)` with a 50-item cap.
- **Android:** `tauri-plugin-android-blocker/` — Kotlin AccessibilityService applies the block/friction gate, WorkManager handles schedule transitions; Rust only bridges Tauri commands.

### Allow-mode / allowlists
"Focus spaces" (allow only these, block everything else) exist on all platforms. The desktop rule (blocklist wins on overlap; concurrent allowlists union) is mirrored on iOS by **two deliberately-duplicated resolvers** that must stay in sync: JS (`deriveIOSEffectiveWebsitePolicy` / `deriveIOSEffectiveAppPolicy` in `src/app.js`) for pre-validation, Swift (`IOSPolicyResolver` in the shared `ScheduleData.swift`) for enforcement. See architecture.md §9.4 and §12.3.

### Frontend module conventions (important, non-obvious)
`src/` is plain ES modules, no framework. Cross-module mutable state lives on the single `state` object in `src/state.js` — module-level `let`s can't be reassigned across ES imports. Module top level holds **declarations only**, never calls into other app modules — this keeps the hub↔feature import cycles safe (all cross-module calls are hoisted functions invoked at runtime). The order-sensitive startup sequence is the `DOMContentLoaded` handler in `src/app.js`. The `window.__REDDBLOCK_INTERNALS__` keys in `src/dev-internals.js` are a contract with the in-app tests — never rename them.

`src/tauri-api.js` is a compat layer. The frontend still calls legacy `*_via_helper` command names that route through `src-tauri/src/commands/helper_shim.rs` (mostly no-ops for website blocking; app blocking forwards to `app_watcher`). This is known tech debt, not a live daemon — there is no `helper-daemon/` in the repo.

### App lifecycle
Closing the window **hides to tray** and keeps all watchers running; only tray **Quit** (sets `ALLOW_EXIT`) terminates the process. Enforcement continues across window close. An EULA gate (revision-based, `CURRENT_EULA_REVISION` in `src/app.js`) blocks post-acceptance startup hooks. v1.x cleanup (hosts strip, legacy daemon removal, may prompt for admin once) runs once via `src-tauri/src/commands/migration.rs`.

## Android build gotchas

Building the Android app from **Android Studio** requires the Tauri CLI running in a terminal (`npm run tauri -- android dev --open`) — Gradle calls back into it for build options. Android Studio launched from the Dock won't have `node`/`npm`/`cargo` on PATH; launch it from a terminal (`open -a "Android Studio"`) or rely on the patched `buildSrc/.../BuildTask.kt` (re-running `tauri android init` drops that patch). `src-tauri/gen/android/` is committed — see [docs/android-build.md](docs/android-build.md) and `docs/android-generated-project-manual-edits.md`.

## Android: build, install, test

### Identity
- **App package id:** `net.kollnig.reddblockandroid` (Android override in
  `src-tauri/tauri.android.conf.json`; the desktop identifier is `com.reddblock`).
- **Launcher activity:** `net.kollnig.reddblockandroid/.MainActivity`
- **Accessibility service (enforcement):**
  `net.kollnig.reddblockandroid/net.kollnig.reddblockandroid.service.BlockerService`

### Frontend bundle
- `tauri android build` runs `npm run vite:build:android` (`vite build --mode android`)
  via the `beforeBuildCommand` override in `tauri.android.conf.json` — so the
  Android-only build optimizations (`stripNonAndroidUi`, the `__ANDROID_BUILD__`
  compile-time guards) apply to the real APK. Plain `tauri build` uses `vite:build`
  (desktop mode, `__ANDROID_BUILD__ = false`).
- Measure the shipped bundle: `ANALYZE=1 npx vite build --mode android` writes a
  treemap to `dist/stats.html`.

### Toolchain gotcha (important)
`cargo`/`rustc` on PATH may resolve to **Homebrew's** rust
(`/opt/homebrew/bin/cargo`), which does **not** have the Android std targets and
fails with `can't find crate for std`. Use the rustup toolchain, which does:

```sh
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$HOME/Library/Android/sdk/ndk/$(ls "$HOME/Library/Android/sdk/ndk" | sort -V | tail -1)"
```

### Build a debug APK (frontend-only changes reuse the cached native `.so`)
```sh
npm run build:android -- --debug --apk true --target aarch64
# APK: src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

### Install + grant accessibility via secure settings, then measure startup
`adb` lives at `$HOME/Library/Android/sdk/platform-tools/adb`. Set `DEV` to the
target serial from `adb devices -l` (e.g. a physical Pixel vs `emulator-5554`).

```sh
ADB="$HOME/Library/Android/sdk/platform-tools/adb"
DEV=<serial>
PKG=net.kollnig.reddblockandroid
SVC="$PKG/net.kollnig.reddblockandroid.service.BlockerService"
APK=src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

$ADB -s $DEV install -r "$APK"          # reinstall keeps app data

# Grant accessibility BEFORE launching (avoids the in-app onboarding gate)
$ADB -s $DEV shell settings put secure enabled_accessibility_services "$SVC"
$ADB -s $DEV shell settings put secure accessibility_enabled 1

# Cold-start timing (force-stop between runs)
$ADB -s $DEV shell am force-stop $PKG
$ADB -s $DEV shell am start -W -n "$PKG/.MainActivity"   # TotalTime = native+webview shell first frame
```

`force-stop` does **not** clear the accessibility grant, so a relaunch loop can
reuse it. But the grant *is* dropped when the service is uninstalled/replaced
(and some ROMs clear it on `install -r`), so re-apply the two `settings put`
lines after any reinstall — otherwise the app cold-starts into the onboarding
gate instead of the main UI, which looks like a regression but isn't. Verify
the grant stuck with:

```sh
$ADB -s $DEV shell settings get secure enabled_accessibility_services   # should list $SVC
```

Note: `am start -W` `TotalTime` measures the **native activity + webview shell**
first frame only. The JS bundle parse and first meaningful paint happen *after*
that in the webview, so `am start -W` under-reports perceived startup. To measure
the JS phase, trace logcat (`$ADB -s $DEV logcat -v time`) and bracket against
the webview `chromium` console line from `checkAndroidPermissions`
(`console.log('Android permissions:', ...)` in `src/blocking-platform.js`).

## Startup performance notes
- The Android frontend is one eager ES-module bundle; startup cost is dominated by
  parsing `dist/assets/main-*.js` in the Android System WebView, not native code.
- `enforcement.js` (desktop/macOS browser-enforcement UI, ~138 KB) is kept out of
  the Android bundle via `if (__ANDROID_BUILD__) return;` guards on its ~52
  desktop-only void functions — Rollup dead-code-eliminates the bodies and
  tree-shakes their helpers/strings. Value-returning shared helpers
  (`browserIconUrl`, `BROWSER_STORE_LINKS`, …) are intentionally **not** guarded.
  `__ANDROID_BUILD__` is a `define` constant set per build mode in `vite.config.js`.
- Same technique gates the desktop-only in-app update flow: `checkForAppUpdate`
  in `src/update-banner.js` is `if (__ANDROID_BUILD__) return;`, which cascades
  to drop `changelog.js` + the bundled `changelog.md` (~52 KB of startup parse)
  from Android. `__ANDROID_BUILD__` is the right tool **only when it lets Rollup
  delete code from the Android bundle** — for plain behavioral branching that
  must stay in the bundle for desktop, use the runtime `state.isAndroid` flag.
- Gating the *code* that references a static asset does not by itself drop the
  asset: Vite emits a file for every `import url from './x.png'` at transform
  time, before tree-shaking, so a desktop-only image whose only reference is
  DCE'd is left orphaned in the APK. The `pruneOrphanAndroidAssets` plugin in
  `vite.config.js` deletes image/video assets referenced by zero chunks/CSS on
  Android (recovered ~3.3 MB: the welcome video + browser-setup screenshots).
  If you add a desktop-only asset, guard its reference with `__ANDROID_BUILD__`
  and the pruner handles the rest; `snooze.png` stays because Android uses it.
