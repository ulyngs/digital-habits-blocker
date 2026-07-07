# Android startup crash: `tao` ndk-context race (proposal)

Status: **known issue, fix proposed (not yet applied)**
Applies to: the Android app (Tauri/`tao` UI process). The Android app currently
lives on the `codex/android-tauri-blocker-clean` branch; this document is filed
against `main` as a tracking/RFC note so the fix can be scheduled deliberately.

## Symptom

On an abrupt/stressed cold start, the Android app process aborts during startup
with a non-unwinding Rust panic:

```
thread '<unnamed>' panicked at ndk-context-0.1.1/src/lib.rs:87:5:
  (Android context not initialized)
via tao-0.34.5/src/platform_impl/android/ndk_glue.rs
panic in a function that cannot unwind
thread caused non-unwinding panic. aborting.
Fatal signal 6 (SIGABRT)
```

To a user it looks like the app fails to open on the first tap after an
update/cold-kill; relaunching works.

## Root cause

The panic is entirely inside **`tao 0.34.5`** (the windowing layer under
`tauri` → `wry`). Our own Rust — `src-tauri/` and
`tauri-plugin-android-blocker/` — never references `ndk_context`
(`grep -r ndk_context` is empty), so this is not our code.

Mechanism, in `tao 0.34.5/src/platform_impl/android/`:

- `ndk_glue.rs` `create()` (invoked from `MainActivity.onCreate` via JNI) calls
  `ndk_context::initialize_android_context()` to publish the global JavaVM +
  Activity handle.
- `ndk_context::android_context()` **panics** ("not initialized") if it is
  called before that. The only *guarded* caller in 0.34.5
  (`mod.rs` `MonitorHandle::size`) first checks `window_manager()` — which is
  set immediately before `initialize_android_context` — so it is safe.
- Under an abrupt/stressed cold start, an **unguarded** access to
  `android_context()` (an Android lifecycle JNI callback / event-loop thread
  running before `create()` finishes initializing) hits the panic. Because it
  crosses an `extern "C"` boundary, the panic cannot unwind → `abort()`.

The crash is on an unnamed (non-main) thread, which is consistent with a
`tao` event-loop / lifecycle thread losing the init race.

## Evidence

- **Non-deterministic:** ~28 launches across triggers reproduced it **0 times**
  (force-stop + component start 0/10, force-stop + launcher 0/10,
  `install -r` + immediate start 0/5, headless-restart check 0/3). Yet the
  device had **6 native tombstones from a prior intense install/launch dev
  session**. So it is a real, recurring-under-stress race with a narrow timing
  window — not a deterministic bug.
- **Not our code:** confirmed no `ndk_context` usage in `src-tauri/` or the
  Android plugin; the panicking frames are all `tao`/`ndk-context`.
- **Not caused by the 16 KB alignment change or the debug build** — the
  panicking path is `tao`'s Activity/context bootstrap, independent of segment
  alignment.

## Severity: low

- **UI-process only.** The panic is in the Tauri/`tao` UI process.
- **Self-recovering.** Relaunching succeeded every time it was observed.
- **Enforcement is unaffected.** App/website blocking is enforced by the native
  Kotlin components (`BlockerService` AccessibilityService + WorkManager
  workers `StopSessionWorker` / `ReEnableWorker`), which do not depend on the
  Tauri UI process. Blocking keeps running even if the UI process aborts on a
  racy cold start.

Real-world exposure is roughly: "occasionally the window fails to open on the
first tap after an update or a cold-kill; tap again and it's fine."

## Proposed fix: bump Tauri (→ `tao 0.35` / `wry 0.55`)

`tao 0.35.x` reworked exactly this path and removes the panic class:

- The panicking `ndk_context::android_context()` is replaced by
  `main_android_context() -> Option<AndroidContext>`, and callers now use
  `let Some(ctx) = ndk_glue::main_android_context() else { … }` — a graceful
  skip instead of an abort.
- Adds a synchronized activity-creation handshake (`recv_timeout`) and
  per-activity context management (`activity_window_manager(activity_id)`).

`tao` is a transitive dependency (`tauri` → `wry` → `tao`). We are on
**`tauri 2.9.5` → `wry 0.53.5` → `tao 0.34.5`**. The fix rides in by bumping
Tauri toward **`2.11.x`** (→ `wry 0.55.1` → `tao 0.35.3`). No first-party code
change is required for the crash itself.

### Why this isn't applied here

Bumping Tauri a minor version is cross-cutting and must not be shipped
untested — it touches desktop (macOS signing/notarization, Windows/MSIX), iOS,
and Android, plus every enforcement/display path. That regression pass belongs
in its own change, separate from this note.

### Verification plan for the fix PR

1. `cargo update -p tauri --precise 2.11.x`; confirm the lockfile resolves to
   `wry 0.55.x` / `tao 0.35.x`; address any Tauri 2.10/2.11 API deltas.
2. Desktop: `npm run build:mac` (+ signing), `build:win`; run the in-app tests
   (`runBlockingTests()` — 132 cases) and a manual smoke test.
3. iOS: build + device smoke test (Screen Time paths).
4. Android: `tauri android build`; device smoke test, and specifically hammer
   cold starts (rapid install+launch loops on a loaded device) to confirm the
   panic no longer occurs.

### Alternative / interim

If a Tauri bump can't be scheduled soon, the crash is low-severity and
self-recovering, so no interim mitigation is strictly required. If desired, a
crash-loop guard (e.g. detect repeated fast aborts and back off) could smooth
the first-tap-after-update case, but it treats the symptom rather than the
cause and is likely more effort than the dependency bump.

### How to nail the exact frame (optional, before touching Tauri)

Reproduce under stress and symbolicate the tombstone against the unstripped
library:

```
ndk-stack -sym src-tauri/target/aarch64-linux-android/debug \
  <logcat-with-the-crash>
```

The panic message + `tao 0.34.5` source already pinpoint
`ndk_context::android_context()` as the failing call; symbolication would only
confirm the exact unguarded caller.
