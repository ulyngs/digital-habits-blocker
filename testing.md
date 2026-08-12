# Digital Habits: Blocker Testing Tiers

This document expands the `README.md` testing section with a deeper technical explanation of each tier, how to run it, what it validates, and what it does not validate.

Terminology in this file follows `README.md`:

- **Tier 0** = plain unit tests over pure `src/` helpers (vitest, no app shell)
- **Tier 1** = in-app logic tests
- **Tier 2** = in-app integration tests (desktop command-path + legacy hosts checks)

There is **no Tier 3** anymore — the v1.x privileged helper daemon and its smoke-test scripts were removed in v2.

---

## Why we use tiers

Each tier answers a different quality question:

- **Tier 0**: Is an individual exported helper correct in isolation?
- **Tier 1**: Is our blocking logic correct as pure behavior?
- **Tier 2**: Do app → Tauri command paths, data persistence, and migration cleanup behave correctly?

No single tier is sufficient on its own. **Website blocking enforcement** (macOS Automation redirects, Windows/Firefox native messaging) is validated primarily through the **manual checklist** — Tier 2 asserts the Rust-derived enforcement snapshot (`current_blocking`), which proves derivation is correct but not that a browser actually redirects.

Tier 0 and Tier 1 overlap in kind but not in reach. Tier 1 owns the
*composed* question — schedule windows, overlaps, allowlist resolution — and
runs the real runner inside a page. Tier 0 exists for the leaf functions that
composition is built out of, which previously had no home above Tier 2: things
like `clampDefaultPauseMinutes`, `androidFrictionChallengeFields` or
`isProtectedApp` are pure, are asserted in milliseconds, and do not need a
browser to be meaningful. When a case fits both, prefer Tier 1 — it is the
layer closer to observed behavior.

---

## Quick run guide

- **Tier 0**: `npm run test:tier0` (add `-- --watch` while iterating)
- **Tier 1**
  - Start app in dev mode: `npm run dev`
  - Trigger tests: `Cmd+Shift+T` (macOS) or `Ctrl+Shift+T` (Windows)
  - Or console: `runBlockingTests()`
- **Tier 2**
  - In app dev console (default fast profile): `runIntegrationTests('core')`
  - In app dev console (expanded profile): `runIntegrationTests('full')`
- **Rust**: `cd src-tauri && cargo test --lib`
- **Android Kotlin**: `cd src-tauri/gen/android && ./gradlew :tauri-plugin-android-blocker:testDebugUnitTest`

---

## What runs in CI

Pull requests to `main` gate every suite; commit and release coverage is
summarized below:

| Workflow | Job | Runs | Trigger |
| --- | --- | --- | --- |
| `ci.yml` | Frontend bundle | `vite:build`, `vite:build:android`, `verify:android-bundle` | every PR, every push to `main` |
| `ci.yml` | Tier 0 unit tests | `npm run test:tier0` — vitest over `test/tier0/**` | every PR, every push to `main` |
| `ci.yml` | Tier 1 logic tests | `npm run test:tier1` — `runBlockingTests()` in headless Chromium | every PR, every push to `main` |
| `release.yml` | Checks (lint + Tier 1) | `npm run lint`, `npm run test:tier1` — gates all four build jobs | every release run |
| `release.yml` | macOS (.pkg) | `cargo test --lib` before signing | every release run |
| `rust-ci.yml` | Rust unit tests | `cargo test --lib` on `macos-latest` | `src-tauri/**` changes, on PRs and `main` |
| `rust-ci.yml` | Clippy (desktop) | `cargo clippy --lib -- -D warnings` on `macos-latest` **and** `windows-latest` | `src-tauri/**` changes, on PRs and `main` |
| `android-ci.yml` | Android debug APK | debug APK build, then `:tauri-plugin-android-blocker:testDebugUnitTest` | `src/**`, `src-tauri/**`, plugin, build config, on PRs and `main` |
| `e2e-ci.yml` | Tier 2 (macOS + Windows) | `runIntegrationTests('full')` against a real built app over WebDriver | Tier 2 sources, `e2e/**`, `vite.config.js`, on PRs and `main` |

Notes on the non-obvious choices:

- **`ci.yml`, `rust-ci.yml`, `android-ci.yml` and `e2e-ci.yml` also run on pushes to `main`.**
  PR checks run against the merge preview, not the commit that ends up on
  `main`, and there is no merge queue — two independently-green PRs can land a
  broken `main`. The push trigger is also the only coverage for commits that
  never went through a PR (direct pushes, admin merges, `release.yml`'s own
  `latest-versions.json` commit). The path filters are duplicated between the
  `pull_request:` and `push:` blocks because GitHub Actions does not support
  YAML anchors; keep each pair in sync. `cancel-in-progress` is scoped to PR
  runs so each `main` commit keeps its own verdict.
- **A release runs its own checks.** `release.yml` is triggered by a `v*` tag
  push or a manual dispatch, neither of which is a PR, so nothing else verifies
  the tagged commit before it becomes a signed installer submitted to the App
  Store and Partner Center. Its `checks` job repeats lint + Tier 1 on `ubuntu`
  and every build job `needs:` it; `cargo test --lib` rides along in the macOS
  build job, which already has the Rust toolchain and a warm cache, and runs
  before any signing certificate is imported.

- **Rust runs on macOS, not Linux.** `web_automation.rs`, `window_inventory.rs`
  and `workspace_events.rs` are `#[cfg(target_os = "macos")]`, and the
  `cfg(not(ios|android))` modules depend on macOS/Windows-only crates, so the
  lib does not compile on a Linux runner at all. No Windows-only module carries
  tests, so macOS covers the whole suite. The job also runs `npm run vite:build`
  first — `tauri_build::build()` refuses to run when the configured
  `frontendDist` (`../dist`) is missing.
- **Kotlin tests run after the APK build, in the same job.** `settings.gradle`
  applies the generated, gitignored `tauri.settings.gradle`, which is what adds
  `:tauri-android` and `:tauri-plugin-android-blocker` to the build. Gradle
  cannot configure the project until the Tauri CLI has written it.
- **The Robolectric suites need network on their first run.** Robolectric
  fetches an `android-all` runtime jar from Maven for the SDK level pinned in
  `src/test/resources/robolectric.properties` and caches it. CI has network, so
  this only shows up as a slower first run; offline, those two suites fail while
  the plain-JUnit ones still pass.

**Tier 2 runs in CI** (`e2e-ci.yml`) against a real built app, because it drives
the actual Tauri command layer and cannot run on a bare page like Tier 1. See
"Tier 2 under WebDriver" below. Running it by hand from the dev console still
works and is unchanged.

---

## Tier 0: Unit Tests

### Purpose

Tier 0 asserts individual exported helpers from `src/` directly, with no app
shell, no built bundle and no Tauri layer. It is where a leaf function's edge
cases belong — boundary values, malformed input, "exact match, not substring".

### Entry points and structure

- Cases: `test/tier0/**/*.test.js`
- Config: `vitest.config.mjs` (kept separate from `vite.config.js`, which
  carries the index.html rewriting, PurgeCSS and Android asset-pruning plugins
  that mean nothing when the entry point is a test file)
- Run: `npm run test:tier0`

### What it covers today

| File | Module under test |
| --- | --- |
| `blocklist-utils.test.js` | protected apps/domains, always-on detection, iOS Screen Time selection normalization, quick-start healing, focus-space colours |
| `schedule-engine.test.js` | Android payload mapping (day names, friction fields), repeat classification, one-off enforcement windows, pause state |
| `pause-and-time-inputs.test.js` | default pause clamp (mirrors Kotlin `coerceDefaultPauseMinutes`), end-time field parsing |

### Notes on the environment

- `environment: 'jsdom'`. Most of these modules are leaf-ish, but several
  import siblings that touch `document` at import time; jsdom means a Tier 0
  test never has to hand-roll a DOM just to get an import to resolve.
- `__ANDROID_BUILD__` is defined as `false`, so modules resolve the same
  branches they do in a desktop build. A helper whose Android behavior differs
  needs the runtime `state.isAndroid` flag, not the compile-time constant — see
  the note in `AGENTS.md`.
- Tests that mutate the shared `state` object must restore it (`try`/`finally`);
  vitest runs a file's tests in one module registry, so a leaked `state.appData`
  is visible to every later case in that file.

### What differentiates Tier 0

- Fastest feedback in the repo — the whole suite is well under two seconds,
  versus a Vite dev server for Tier 1 and a full app build for Tier 2.
- Proves nothing about composition or about anything reaching the Tauri layer.
  A passing Tier 0 suite and broken blocking are entirely compatible.

---

## Android Kotlin unit tests

Run: `cd src-tauri/gen/android && ./gradlew :tauri-plugin-android-blocker:testDebugUnitTest`

| Suite | Covers | Runner |
| --- | --- | --- |
| `BrowserUrlParserTest` | URL-bar text → blockable domain, per browser | plain JUnit |
| `SchedulesTest` | which schedule blocks an app/domain; session, pause and time-window gating; SharedPreferences round-trip | plain JUnit |
| `BlockerServiceTest` | an accessibility event → the friction gate launches with the right payload, or provably does not (keyguard, self-package, throttle, unblocked app) | Robolectric |
| `UnlockActivityTest` | the friction gate: challenge generation and validation, pause commit, dismissal paths | Robolectric |

Why this matters more than it looks: **Android shares none of the desktop
enforcement code.** `Schedules.kt` re-implements the semantics `native_host::derive_payload`
derives on desktop, and nothing but these two test suites keeps the two in step.
A change to blocking semantics needs a case on both sides.

### Environment notes

- `isReturnDefaultValues = true` keeps plain-JUnit tests from throwing on
  `android.util.Log`. Robolectric supplies its own framework implementation and
  is unaffected.
- A real `org.json` is on the test classpath ahead of the stub, so
  `Schedules`'s persistence round-trips actually round-trip instead of silently
  producing empty data.
- Robolectric emulates the SDK level pinned in
  `src/test/resources/robolectric.properties` rather than following `compileSdk`,
  so bumping `compileSdk` does not silently change what the tests run against.
- `isIncludeAndroidResources = true` lets `UnlockActivityTest` inflate
  `R.layout.activity_unlock` and resolve `R.string` / `R.color`.
- `androidx.work:work-testing` supplies the WorkManager that
  `Schedules.pauseSchedule` enqueues a `ReEnableWorker` into; without it the
  gate's confirm path throws.

### What these do not cover

- The **website interception path** in `BlockerService`, which reads the browser
  accessibility tree via `rootInActiveWindow`. Robolectric cannot populate that
  for an AccessibilityService. The parsing half is covered by
  `BrowserUrlParserTest`; the end-to-end half stays on the manual checklist.
- `ScheduleManager`'s real WorkManager scheduling, and anything that depends on
  a real device's accessibility grant.

---

## Tier 1: In-App Logic Tests

### Purpose

Tier 1 validates logic and state-composition rules without Tauri side effects or system file mutation.

### Entry points and structure

- Runner and categories: `src/blocking-tests.js`
- Pure helper/test functions: `src/test-utils.js`
- Loaded in dev UI via script tags: `src/index.html`
- Keyboard shortcut wiring: `src/app.js` (`Cmd/Ctrl + Shift + T`)

### What it actually tests

`src/blocking-tests.js` currently covers logical categories such as:

- time-window behavior (active/future/expired),
- schedule/day/time activation (including cross-midnight),
- overlap/union semantics,
- shared-domain edge cases,
- override and override-all state transitions,
- challenge difficulty selection (including max-difficulty effective count),
- blocklist duplication (data shape, naming, override copy, schedule copy),
- protected app/domain guards,
- iOS allowlist effective-policy resolvers (Category 14, **T55–T62**).

The Category 14 tests are **logic tests, not behavior tests**: they exercise
the pure JS functions that decide what iOS Screen Time enforcement should do
(`specific-block` vs `all-except`, blocklist-wins subtraction, Apple's
50-exception cap, category-token exclusion) — constraints with no desktop
equivalent. They run in the normal desktop dev build; no iOS build, simulator,
or device is involved. Desktop's own allowlist composition rules live in Rust
and are covered by `cargo test` (see **Rust unit tests** below).

It uses mock `appData` and pure functions from `src/test-utils.js` including:

- `getBlockedDomains(...)`
- `hasAnyActiveBlocks(...)`
- `findHardestChallengeAtTime(...)`
- `simulateOverrideAll(...)`

### What differentiates Tier 1

- Very fast and deterministic.
- Excellent for regression in business logic.
- Minimal environment dependency.

### Important limitations

- Does not prove real Automation redirects (macOS) or extension blocking (Windows/Firefox).
- Does not prove app-watcher quit behavior (manual checklist covers that).
- App watcher behavior is mostly marked as manual/placeholder in this tier.

---

## Tier 2: In-App Integration Tests

### Purpose

Tier 2 validates real side effects through the same app pathways users hit:

- frontend state updates,
- Tauri command calls (`save_data`, legacy `*_via_helper` shims, `clean_hosts_file`, app-blocking commands),
- pause/resume flag propagation,
- diagnostics contract.

It does **not** run a separate helper daemon. `check_helper_status()` always reports the app itself as ready via `helper_shim.rs`.

### Entry points and structure

- Integration suite: `src/integration-tests.js`
- Exposed runner: `window.runIntegrationTests(profile)`
- Uses internals exported by app runtime:
  - `window.__REDDBLOCK_INTERNALS__` from `src/app.js`

Core internal handles used:

- `appData`
- `saveData`
- `updateHostsFile` (legacy name — does not write hosts in v3)
- `tauriAPI`
- `render`

### Current profile model

- `runIntegrationTests('core')` — fast critical checks for regular local use.
- `runIntegrationTests('full')` — `core` plus expanded non-UI coverage.

Default behavior with invalid/missing profile falls back to `core`.

### Tier 2 exact test IDs and profile coverage

### Testing Group A: One-off and schedule mechanics
- **A1**: Enforcement derivation path (start → enforced, stop → cleared)
- **A2**: One-off start/end timing
- **A3**: Schedule active-now path
- **A4**: Future schedule path (**full only**)
- **A5**: Pause/resume one-off state path (**full only**)
- **A6**: Pause/resume one-off enforcement path
- **A7**: Pause natural-expiry one-off smoke (**full only**)
- **A8**: Pause/resume schedule active path (**full only**)
- **A9**: Pause natural-expiry schedule smoke (**full only**)
- **A10**: Pause inactive schedule suppression path (**full only**)
- **A11**: Data file owns enforcement — the legacy `set_blocks_via_helper` shim is ack-only and must not affect derived enforcement (**full only**)

Expected outcome for A2–A10, A11:
- blocking and schedule state transitions succeed through save + shim command paths
- pause/resume transitions update flags and sync without errors
- short timer-smoke checks confirm automatic pause expiry clears pause flags

### Testing Group B: Multi-block overlap correctness
- **B1**: Shared-domain overlap
- **B2**: One-off + schedule same blocklist (**full only**)

### Testing Group C: Clear and override semantics
- **C1**: Scoped clear by blocklist ID (shim ack + frontend clear path)
- **C2**: Clear-all manual blocks (**full only**)
- **C3**: Max difficulty blocklist start/clear path (**full only**)

### Testing Group E: Legacy-command and diagnostics invariants
- **E1**: Clean hosts command path (v1 migration cleanup — succeeds and is idempotent; v3 never writes hosts)
- **E2**: Diagnostics contract (v3 shim: always-ready helper status, `app_version` + `backend` label)

### Testing Group F: App-block command-path checks (non-visual)
- **F1**: Set blocked apps command path (**full only**)
- **F2**: Protected app payload path (**full only**)

### Testing Group G: Blocklist management
- **G1**: Duplicate blocklist then start/clear path (**full only**)

### Testing Group H: Allowlist mode (desktop websites channel)
- **H1**: Single allowlist enforcement state
- **H2**: Concurrent allowlists union (**full only**)
- **H3**: Allowlist + blocklist overlap (**full only**)
- **H4**: Pause/resume allowlist enforcement path (**full only**)

Group H creates, starts, pauses, and clears real allow-mode focus spaces
through the same save + sync path users hit (visible in the UI as the suite
runs). Each H test runs isolated (state reset before and after, same
mechanism as A4/A5/A7–A11), so leftover blocks from earlier failing tests
cannot skew its assertions. It asserts the Rust-derived enforcement snapshot via
`get_system_diagnostics` → `current_blocking` (`allowed_domains`,
per-block `mode`, flat blocked list) — the modern allowlist-aware read-back,
not the legacy hosts payload. Per-URL block/allow decisions and
blocklist-wins subtraction are decision-time logic covered by Rust unit tests
and Tier 1 Category 14. Group H is deliberately **websites-only**: automating
allow-mode app enforcement would enroll the tester's real open apps for quit —
that surface is manual checklist section 15.

## Tier 2 profile composition

- `core`: `A1`, `A2`, `A3`, `A6`, `B1`, `C1`, `E1`, `E2`, `H1`
- `full`: `core` + `A4`, `A5`, `A7`, `A8`, `A9`, `A10`, `A11`, `B2`, `C2`, `C3`, `F1`, `F2`, `G1`, `H2`, `H3`, `H4`

## Suite behavior

1. Setup snapshots the current `appData` so the suite can restore the user's state when it finishes.
2. Tests run sequentially by selected profile.
3. Some full-only pause/schedule cases use per-test reset/setup-cleanup boundaries.
4. Teardown restores the saved snapshot, saves it, and re-syncs via legacy shim commands.
5. When profile is `full` and at least one test fails, output includes a bottom **Group failure summary** for groups `A`–`H`.

### What differentiates Tier 2

- Real Tauri command flow from UI-side code.
- Catches persistence and shim regressions missed by Tier 1.

### Important limitations

- All groups now assert the Rust-derived enforcement snapshot (`get_system_diagnostics` → `current_blocking`), not the removed v1 hosts payload. This proves derivation and command paths, **not** browser-visible redirects.
- The legacy `*_via_helper` clear/set commands are acknowledgment-only shims on v3; the real clear path is the frontend mutating app data and saving. The rewritten C/B tests exercise both (shim ack + real path); A11 pins that shim payloads alone never affect enforcement.
- Some checks are command-path assertions, not UI-visible assertions.
- Not a substitute for manual Automation TCC flows, extension install, or enforcer grace UX.
- **Tech debt:** renaming `updateHostsFile()` (legacy name; it drives v3 sync).

---

## Tier 2 under WebDriver (experimental)

Tier 2 can also be driven from outside the app by attaching a WebDriver session
to the built app's webview:

```
npm run build:e2e-app      # app built with the test runners kept in the bundle
npm run test:tier2         # drives runIntegrationTests('full') and fails on any failure
```

Three things make this work, and all three are easy to trip over:

- **The app must be built in `e2e` Vite mode.** Normal builds strip
  `test-utils.js` / `blocking-tests.js` / `integration-tests.js` from the
  bundle, so `runIntegrationTests` would not exist in the webview.
  `src-tauri/tauri.e2e.conf.json` swaps `beforeBuildCommand` to
  `npm run vite:build:e2e`, which keeps the `<script>` tags *and* emits the
  three classic scripts into the output root (Vite never bundles them).
- **`e2e/specs/tier2.e2e.js` is a driver, not a test.** All the assertions stay
  in `src/integration-tests.js` so the suite remains runnable by hand from the
  dev console. The spec only waits for the harness, starts the run, polls, and
  fails on any failed case — the same contract `run-tier1-headless.mjs` has
  with Tier 1.
- **Both platforms use the embedded WebDriver server.** The app serves
  WebDriver itself via the `e2e-webdriver` Cargo feature, so there is no
  external driver to install. Windows originally used `external`
  (`tauri-driver` + msedgedriver), which is the path Tauri's CI guide
  documents, but it never established a session on a runner — `POST /session`
  timed out at 180 s, twice, with the suite never starting. The embedded server
  was already green on macOS, so both jobs share it.

**`e2e-webdriver` must never ship.** It compiles an HTTP automation server into
the binary, and in a released blocker that is a remote-control bypass of every
block the app enforces. It is an explicit opt-in feature rather than the
crate's documented `#[cfg(debug_assertions)]` gate, which would open the port
on every `npm run dev` session. `lib.rs` additionally carries a
`compile_error!` that fails the build if the feature is ever combined with a
release profile, so the mistake is impossible rather than merely unlikely.

Tier 2 mutates real state, which is why it stays manual locally and runs on a
disposable runner VM in CI. Its test domains are all `.invalid` by
construction.

---

## Rust unit tests

Desktop enforcement semantics live in Rust and carry their own unit tests,
run outside the app:

```
cd src-tauri && cargo test --lib
```

(Use `--lib`; bare `cargo test` currently fails compiling a stale
`test_watcher` example binary.)

Coverage relevant to blocking behavior:

- `web_automation.rs` — URL block/allow decisions, including the **desktop
  allowlist semantics**: allowlist blocks non-allowed hosts, allowlist-only
  sessions count as active web enforcement, concurrent allowlists union,
  blocklist precedence on overlap, and block-page metadata attribution
  (blocklist hit wins; else earliest-started allowlist).
- `native_host.rs` — extension payload derivation (`derive_payload`),
  including allowlist domains staying out of the legacy flat blocklist.
- `profile_scan.rs`, `window_inventory.rs`, `commands/diagnostics.rs`,
  `commands/migration.rs` — supporting surfaces.

Run these before merging changes to `web_automation.rs`, `native_host.rs`,
`app_watcher.rs`, or `enforcer.rs`. CI also runs them on every PR that touches
`src-tauri/**` (`rust-ci.yml`), so a red job there means one of these failed.

---

## Android Kotlin unit tests

Android website blocking hinges on reading the URL out of each browser's URL
bar via the accessibility tree. That parsing lives in
`tauri-plugin-android-blocker/.../service/BrowserUrlParser.kt` — deliberately
free of Android framework types so it runs as a plain JVM test:

```
cd src-tauri/gen/android && ./gradlew :tauri-plugin-android-blocker:testDebugUnitTest
```

CI runs this too, as a step of the Android debug-APK job (`android-ci.yml`);
on failure the HTML report is uploaded as the `kotlin-unit-test-report`
artifact.

`BrowserUrlParserTest` pins **verbatim URL-bar strings dumped from real
devices** (`adb shell uiautomator dump`), quirks included. This matters because
a browser-specific quirk here fails *silently*: the browser stays in the
supported-package map, extraction just returns nothing, and that browser never
blocks with no error anywhere. That is exactly how Samsung Internet's invisible
`U+200E` LTR-mark prefix went unnoticed.

**When adding or fixing a browser:** open a site in it, `uiautomator dump` the
tree, add the raw `text` value of its URL-bar node as a fixture, then verify on
a device (`logcat -s BlockerService` should log `Blocking website …`). The unit
test proves parsing; only the device proves the accessibility event actually
arrives and the friction gate launches.

---

## Tier Comparison

- **Tier 1 (logic)**: high breadth of logic permutations, zero system mutation.
- **Tier 2 (integration)**: moderate breadth, Tauri command paths with the `current_blocking` enforcement snapshot as read-back.
- **Rust unit tests**: enforcement decision logic (URL matching, allowlist composition, payload derivation).
- **Android Kotlin unit tests**: browser URL-bar parsing (`BrowserUrlParser`), against fixtures dumped from real devices.
- **Manual checklist**: required for website enforcement, permissions, enforcer, and visual UX.

Recommended stance:

- Run Tier 1 during feature work.
- Run Tier 2 for data/sync/shim regressions; do not treat passing Tier 2 as proof of website blocking.
- Run the manual checklist before every release.

---

## iOS and testing tiers

iOS enforcement uses the Screen Time plugin (`tauri-plugin-screentime`).

- **Tier 1 (logic):** Runs in the app; safe on iOS. Same blocking/schedule/override logic applies. **Category 14 (T55–T62)** covers the iOS allowlist effective-policy resolvers — run it on the desktop dev build; the resolvers are shared JS and encode iOS-only constraints (Apple's 50-exception cap, `specific-block` vs `all-except`, category-token exclusion).
- **Tier 2 (integration):** Desktop-oriented; helper-dependent paths always see the shim as “ready” but do not exercise Screen Time. **Manual checklist is the primary way to validate iOS.**
- **Enforcement layer:** cannot be automated — FamilyControls authorization and shields do not work meaningfully in the simulator, and `ManagedSettingsStore` state cannot be read back. See `architecture.md` §12.3 for device-validation findings and known carve-outs.

For release, run the **manual test checklist** (section **14. iOS-Specific**, including the **14.1 iOS allowlist matrix**) on a physical iPhone.

---

## Typical contributor workflow

1. Run Tier 1 during active feature work for fast feedback.
2. Run Tier 2 before merging changes that touch save/sync/shim/app-blocking command paths (Group H when touching allowlist derivation or sync).
3. Run `cargo test --lib` before merging changes to Rust enforcement code.
4. Run the manual checklist for website blocking, permissions, enforcer, and release confidence — section 15 for desktop allowlist, section 14/14.1 for iOS.

---

## Common troubleshooting

- **Tier 1 not running:**
  - confirm `src/index.html` includes `test-utils.js` and `blocking-tests.js`.
  - confirm shortcut handler in `src/app.js` is active in current build.
- **Tier 2 failing with "current_blocking missing from system diagnostics":**
  - confirm the `get_system_diagnostics` command is registered and `tauriAPI.getSystemDiagnostics` exists in `src/app.js`.
- **Tier 2 failing at setup/teardown:**
  - confirm `window.__REDDBLOCK_INTERNALS__` exports are present from `src/app.js`.
