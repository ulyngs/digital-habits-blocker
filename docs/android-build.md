# Building the Android app

The Android app is the shared Tauri/Vite frontend packaged with the native
`tauri-plugin-android-blocker` (Kotlin AccessibilityService + WorkManager). A
build runs three stages back to back: Vite bundles `src/` → Rust cross-compiles
the Tauri core for the Android ABI(s) → Gradle compiles the Kotlin/Java and
packages the APK.

The generated Gradle project lives in `src-tauri/gen/android/` and is committed
(see [android-generated-project-manual-edits.md](android-generated-project-manual-edits.md)
for the app-specific edits to preserve if it's ever re-initialized).

## Prerequisites

- **Android SDK** with platform-tools and build-tools (via Android Studio).
- **Android NDK** — install through Android Studio's SDK Manager. It lands in
  `$ANDROID_HOME/ndk/<version>/`.
- **JDK 17+** — Android Studio bundles one (JBR); a standalone JDK works too.
- **Rust Android targets** — install the ones matching the device/emulator ABI:
  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi \
                    i686-linux-android x86_64-linux-android
  ```
- **Tauri CLI** (`npm install` provides it locally as `./node_modules/.bin/tauri`).

## Build cache

Tauri commands launched through npm use a shared Cargo target cache outside the
repository, so linked Git worktrees reuse compiled Rust dependencies instead of
creating a separate `src-tauri/target/` in each checkout. Set
`REDD_BLOCK_CARGO_TARGET_DIR` to override the location, or
`REDD_BLOCK_BUILD_CACHE_DIR` to change the cache root.

The cache includes every Rust target and build profile you use. Stop active
builds before pruning it:

```bash
npm run clean:build-cache -- --all
```

This removes generated Cargo, Vite, and Android build output only. It does not
remove `node_modules` or files in `for-distribution/`.

## Environment variables

The Tauri/Gradle build reads the SDK, NDK, and JDK from the environment. These
are **not** set by `npm install`, so a bare `npm run build:android` fails with an
empty `ANDROID_HOME` unless you export them (Android Studio sets them itself when
you build from the IDE). Add to your shell profile, or `export` per session:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
# Pick the installed NDK dynamically so this doesn't rot when it updates:
export NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"
export JAVA_HOME="$(/usr/libexec/java_home)"   # macOS; or your JDK path
```

Paths above are macOS defaults. On Linux the SDK is typically
`$HOME/Android/Sdk`; on Windows, `%LOCALAPPDATA%\Android\Sdk`.

## Debug APK (for local testing)

```bash
npm run build:android:debug
```

- `--apk true --aab false` — build the APK, skip the Play Store AAB. (In Tauri
  CLI 2.x the `--apk`/`--aab` flags require an explicit `true`/`false` value.)
- `--debug` — debuggable, unminified build (`android:debuggable=true`).
- `--target aarch64` — build a single ABI (`arm64-v8a`) instead of all four.
  This covers physical devices and Apple-silicon/arm64 emulators, and is much
  faster. Omit `--target` to build a universal APK (all ABIs) for, e.g., an
  x86_64 emulator.

Output:

```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Install and watch logs on a connected device (`adb devices` should list it):

```bash
$ANDROID_HOME/platform-tools/adb install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
$ANDROID_HOME/platform-tools/adb logcat | grep -i reddblock
```

After the first install, enable **ReDD Block** under
**Android Settings → Accessibility** so blocking can run.

## Live development

For an iterate-and-reload loop on a running device/emulator (hot-reload of the
frontend), use dev mode instead of a full build:

```bash
npm run dev:android          # = tauri android dev
npm run tauri -- android dev --open   # also opens Android Studio
```

## Release build

```bash
npm run build:android        # = tauri android build (all ABIs, release, APK + AAB)
```

Ordinary release builds still use the generated debug signing config unless the
Keychain-backed Play Store script below supplies a release key. Do not upload an
ordinary `npm run build:android` artifact to Google Play.

## Google Play bundle with macOS Keychain signing

For a locally signed Play Store bundle, use the repository signing script. It
stores the keystore password, key password, and alias in the macOS Keychain;
normal builds do not prompt for credentials and no signing secret is written to
the repository:

```bash
./scripts/build-android-play.sh --setup   # one time per Mac/keychain
./scripts/build-android-play.sh
```

The script uses `~/StudioProjects/Keys/redd.jks` by default, or the path in
`REDD_BLOCK_ANDROID_KEYSTORE`, and writes the verified AAB to
`for-distribution/android/`. It also configures Gradle's release signing only
for the credentials supplied by this script; ordinary local release builds
retain the existing debug-key fallback.

## Building from Android Studio

You can open `src-tauri/gen/android/` in Android Studio to run/debug the project,
but the Gradle Rust task calls back into a running Tauri CLI:

1. Keep the CLI running in a terminal while you build:
   `npm run tauri -- android dev --open`. Without it the build panics with
   "failed to read CLI options".
2. `node`/`npm` and `cargo` must be on Gradle's PATH. Android Studio launched
   from the Dock doesn't inherit your shell PATH — either launch it from a
   terminal (`open -a "Android Studio"`) or rely on the PATH patch in
   `buildSrc/.../BuildTask.kt` (which is dropped if `tauri android init` is
   re-run).

## Troubleshooting

- **`ANDROID_HOME` / `sdk.dir` not found** — export the env vars above, or set
  `sdk.dir` in `src-tauri/gen/android/local.properties`.
- **NDK not found** — confirm `$NDK_HOME` points at an existing
  `$ANDROID_HOME/ndk/<version>` directory.
- **Missing Rust target** — `error: ... target may not be installed` →
  `rustup target add <triple>` for the ABI you're building.
- **`adb devices` empty** — a device isn't required to *build* the APK, only to
  install it. Enable USB debugging (physical) or start an emulator.
