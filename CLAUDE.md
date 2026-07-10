# CLAUDE.md

Guidance for working in this repo. Tauri v2 app (Rust backend + JS/webview frontend)
targeting macOS, Windows, iOS, and Android.

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
