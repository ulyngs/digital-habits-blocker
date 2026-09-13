# Digital Habits: Blocker Pre-Release Test Checklist

## Before Each Release

Run this checklist before publishing a new version. Use a test blocklist with safe, non-critical sites.  
For iOS builds, run **section 14 (iOS-Specific)** on a physical device.

**Platform notes (v3):**
- **macOS Safari/Chrome/Brave/Edge:** website blocking via **Automation** (no extension).
- **macOS Firefox + all Windows browsers:** Digital Habits: Focus **extension** + native messaging.
- **No helper daemon, no hosts-file writes** for blocking (v1 cleanup may still strip old markers once).

---

## 1. Automated Tests

- [ ] Start app in dev mode: `pnpm dev`
- [ ] Run Tier 1: **Cmd+Shift+T** (Mac) / **Ctrl+Shift+T** (Windows), or `runBlockingTests()`
- [ ] Run Tier 2 `core`: `runIntegrationTests('core')`
- [ ] If the release touches pause/schedule, overlap/clear, or app-blocking command paths, also run Tier 2 `full`
- [ ] Treat Tier 2 **hosts assertions (A1, C1, …) as legacy** — passing Tier 2 does not prove website blocking on v3
- [ ] Verify automated tests pass; fix regressions before proceeding

---

## 2. One-Off Blocks

### Basic Flow
- [ ] Create blocklist with 2 websites (e.g., example.com, test.com)
- [ ] Start a 2-minute one-off block
- [ ] **macOS (Safari/Chrome/Brave/Edge):** verify blocked URLs redirect to bundled block page
- [ ] **macOS Firefox / Windows:** verify blocked URLs redirect to extension block page
- [ ] If blocklist includes apps: add a safe app (e.g., Calculator, Notes), start block, verify warning → quit flow; end block and verify app opens normally
- [ ] Wait for expiration
- [ ] Verify sites are unblocked

### Cross-Midnight Block
- [ ] Start a block late at night that crosses midnight
- [ ] Verify block continues after midnight
- [ ] Verify correct "time left" display

### Pause / Resume (One-Off)
- [ ] Start a 10-minute one-off block; confirm sites are blocked
- [ ] Pause from block card/calendar → sites become unblocked while paused
- [ ] App blocking for that blocklist disabled while paused (if apps in list)
- [ ] UI shows paused state and resume countdown
- [ ] Resume before pause expiry → sites blocked again immediately
- [ ] Pause again; let pause expire naturally → block auto-resumes
- [ ] Final block end time still works after pause cycle

---

## 3. Scheduled Blocks

### Basic Schedule
- [ ] Create schedule starting in ~2 minutes → badge "In X mins"
- [ ] Wait for segment → sites blocked (and apps if in blocklist)
- [ ] Badge shows "X min left"
- [ ] Wait for segment end → sites unblocked

### Cross-Midnight Schedule
- [ ] Segment e.g. 23:00 → 02:00; verify time-left at both ends

### Pause / Resume (Schedule)
- [ ] Active schedule: pause → sites unblocked; resume → blocking returns if still in segment
- [ ] Pause until expiry → schedule auto-resumes; next segment/day still works

### Pause While Schedule Is Inactive
- [ ] Schedule with next segment in ~5 min, not active yet
- [ ] Pause shorter than gap → segment activates after pause ends
- [ ] Pause overlapping segment start → activation suppressed until resume

---

## 4. Overlap Scenarios

### Shared Domains and Apps
- [ ] Blocklists A and B share a domain (and optionally an app)
- [ ] Start both; stop A → shared domain still blocked by B

### One-off + Schedule (Same Blocklist)
- [ ] One-off + schedule on same list; override one-off → schedule still blocks
- [ ] Override schedule → sites unblocked

---

## 5. Blocklist Management

(Duplication flows — same as before: name derivation, override copy, schedule copy, scoped clear.)

- [ ] Duplicate one-off blocklist → derived name, same settings, not auto-started, scoped clear works
- [ ] Duplicate scheduled blocklist → full schedule copied, runs across segments, scoped clear works

---

## 6. Override Functionality

- [ ] Max difficulty UI: lock count, restore on uncheck
- [ ] Single-block override with challenge → block cleared
- [ ] Override All uses hardest challenge; clears all active blocks/schedules; blocklists remain

---

## 7. Edge Cases

- [ ] Block at exact time schedule ends → no gap
- [ ] Close/reopen app during active block → block persists
- [ ] Pause, close app, reopen → paused state preserved
- [ ] Override All during paused block → block cleared correctly

---

## 8. Advanced Settings

### Diagnostics
- [ ] Settings → Diagnostics opens without error
- [ ] **macOS:** Automation permission status per browser (Safari, Chrome, Brave, Edge)
- [ ] **macOS Firefox / Windows:** extension installed / enabled / private-browsing status per browser
- [ ] **Windows only:** native-messaging manifest paths listed and present on disk
- [ ] Copy to clipboard works

### Still Not Working
- [ ] Support modal opens/closes without closing Settings underneath

### Data / Reinstall
- [ ] Blocklists persist across close/reopen
- [ ] Reinstall (if tested): data restores from canonical shared path when applicable

---

## 9. First-Launch Upgrade Migration (from v1.x)

Test on a profile with v1 residue (or simulated hosts markers + legacy launchd plist).

- [ ] Launch → admin/UAC prompt to remove legacy daemon (user can cancel → retry banner)
- [ ] After success: hosts markers gone, legacy plist/binary cleaned, `migrationRanAtVersion` stamped
- [ ] **Windows:** native-messaging manifests written for Chromium/Firefox
- [ ] **macOS:** Chromium native-messaging manifests **not** auto-written (Automation path); Firefox manual
- [ ] Relaunch → idempotent, no re-prompt

---

## 9b. Per-User Data Migration (shared machine)

App data used to be one machine-wide file, so on a shared PC the whole
family got one blocklist and only the account that created the file could
write it. No automated layer covers this: it needs two real accounts on one
machine. Do steps 1–5 on Windows, then 6 on macOS.

Requires two local accounts, A and B, both of which have launched the app.

- [ ] 1. **Reproduce first, on the currently released build.** As A, set a
      blocklist. Log in as B: B sees A's list, and B's edits fail to persist.
- [ ] 2. Upgrade to the new build and launch as A → A's list survives, and now
      lives in `%APPDATA%\com.reddblock\redd-block-data.json`
- [ ] 3. Log in as B → B has **a copy of the rules already being enforced on
      them**, not an empty list. (Importing for the non-owning account is
      deliberate: skipping would silently unblock B.)
- [ ] 4. Edit B's list → A's is unchanged; edit A's → B's is unchanged. Both
      accounts can now actually save.
- [ ] 5. In each account, confirm a blocked domain is still blocked in a
      browser, and that the native host resolved the same per-user file the app
      writes (`native-host.log` sits next to it)
- [ ] 6. Repeat 2–4 on macOS, including one machine that still has
      `/var/lib/redd-block/redd-block-data.json`, to cover the v1.x import path
- [ ] 7. `%PROGRAMDATA%` / `/var/lib/redd-block` copies are **left in place** —
      accounts that have not upgraded yet still need to import them

---

## 10. Website Blocking Compliance & Enforcer

Requires `settings.enforcementEnabled` (opt-in in extension/setup dialog). Grace period defaults to 60 s (user-configurable 5–300 s); **same duration for first and repeat offenses**.

### macOS — Safari, Chrome, Brave, Edge (Automation)

- [ ] Setup row shows per-browser Automation status
- [ ] Revoke Automation for browser X in System Settings → during active block, grace banner appears
- [ ] Re-grant before timer expires → banner clears, browser stays open
- [ ] Let timer expire → browser force-quit; `enforcer://browser-closed` event
- [ ] Start block → navigate to blocked domain → redirect to bundled `blocked.html` within ~1 s
- [ ] **Allowlist (Automation):** start allowlist with `github.com` only → open `reddit.com` → bundled `blocked.html` subtitle says site is not on your current allowlist; pill/countdown/source rows still populate from block metadata

### macOS Firefox / Windows (extension)

- [ ] Missing/disabled extension or private-browsing not allowed → setup/compliance banner
- [ ] During active block with enforcement on: disable extension → grace countdown → force-quit at expiry
- [ ] Re-enable before expiry → grace clears
- [ ] Navigate to blocked domain → extension `blocked.html` with metadata
- [ ] **Allowlist (extension):** start allowlist with `github.com` only → open `reddit.com` → extension `blocked.html` shows the same allowlist subtitle, pill, site row, reason, and countdown as Automation (via `mode=allowlist` query param)

### Native messaging (Windows + macOS Firefox)
- [ ] Block active → blocked domain redirects in browser
- [ ] Native host spawned on demand (check logs if available)

---

## 11. App Watcher (in-process, desktop)

- [ ] Add safe blocked app; start block → "Let's go!" warning → 30 s pre-quit → polite quit → force-close if needed
- [ ] Launch blocked app mid-block → fast-path close (no full warning flow)
- [ ] End block → app usable again
- [ ] **No** persistent `osascript` NSWorkspace subprocess (v3 uses sysinfo poll in-process)

---

## 12. macOS Automation Setup

- [ ] Fresh user or revoked Automation: setup rows show "Grant access" / "Show me how"
- [ ] Grant access → macOS Automation consent for that **browser** (not generic System Events)
- [ ] Open Automation settings → System Settings → Privacy & Security → Automation
- [ ] Launch probe does **not** relaunch force-closed browser on background UI refresh (only on explicit Grant)

---

## 13. Persistence: Hide-on-Close + Launch-at-Login (macOS)

- [ ] ⌘W / red close → window hides, tray remains
- [ ] Tray click reopens window; Dock icon follows Regular/Accessory policy
- [ ] Tray Quit fully exits
- [ ] Launch at login (release build): agent registered; survives logout/login when enabled

---

## 14. iOS-Specific (Physical Device Only)

Screen Time APIs — no hosts file, helper, or browser extension.

(Cover permissions, one-off/schedule blocks, pause/resume, overlap, override, app blocking — same behavioral intent as desktop sections 2–7 where applicable.)

- [ ] Screen Time authorization on first block
- [ ] One-off and schedule blocking for websites/apps
- [ ] Pause/resume and override flows
- [ ] No desktop-only settings (Clean hosts, helper lifecycle)

### 14.0 Screen Time picker cannot loosen a running block

Only a real `FamilyActivityPicker` can cover this — no automated tier can drive
the native sheet. Block-mode focus space, with a block or committed schedule
currently running:

- [ ] Edit → Browse → deselect a blocked app → Done: the app is still listed,
      and still blocked after Save
- [ ] Edit → Browse → deselect *everything* → Done: the selection returns to
      what was saved, not empty
- [ ] Edit → Browse → add an app → Done: the addition sticks (tightening stays
      free) and enforces after Save
- [ ] Pause the block first → Browse → deselect: the removal now goes through
- [ ] While paused, deselect → Done, then let the pause expire before Save: the
      persisted selection is restored instead of loosening the resumed block
- [ ] After enforcement resumes, undo a picker merge and Save: the persisted
      selection still remains the floor
- [ ] No block or schedule running → Browse → deselect: removal goes through

### 14.1 iOS allowlist matrix (Allow-mode focus spaces)

Prereqs: physical device, Screen Time authorized, note any other authorized
Screen Time apps and Settings › Screen Time › Always Allowed contents first
(both are known enforcement carve-outs — see architecture.md §12.3).

- [ ] Websites-only allowlist: allowed sites load, all other sites shielded (manual block)
- [ ] Apps-only allowlist: allowed apps open (no shield, not even a generic "Restricted" one), other apps shielded, websites unaffected
- [ ] Mixed allowlist (websites + Screen Time apps): both resource types enforce
- [ ] Two concurrent allowlists: allowed sets union (both spaces' items usable)
- [ ] Allowlist + blocklist overlap (domain): overlapping domain blocked, rest of allowlist intact
- [ ] Allowlist + blocklist overlap (app token): overlapping app shielded (blocklist wins)
- [ ] Manual allowlist ends via one-off with app fully closed: enforcement lifts
- [ ] Allowlist schedule segment starts/ends with app fully closed: enforcement flips at boundaries
- [ ] Pause → resume (manual and schedule): free during pause, allowlist (not blocklist) semantics return on resume
- [ ] Stop-all clears both stores: no stuck shields or web filter afterwards
- [ ] Shield copy on allowlist-blocked app: "isn't one of the apps you've allowed yourself to use" + "Focus space information:" + focus-space pill + timing line
- [ ] Shield copy on allowlist-blocked site: "isn't one of the ones you've allowed yourself to use" + "Focus space information:" + focus-space pill + timing line
- [ ] Explicit-blocklist shield copy unchanged (regression)
- [ ] >50 allowed websites: start fails with the domain-limit alert, no enforcement
- [ ] >50 allowed apps: start fails with the app-limit alert, no enforcement
- [ ] Allow-mode picker shows the category-expansion footnote; ticking a category returns its member apps as individual app tokens and stores no category token (chip shows "N apps selected", N = member count)
- [ ] Allow-mode start with a picker-expanded category: member apps stay usable, everything else shielded; no categories dialog
- [ ] Legacy allow-mode selection with category tokens alongside apps: "App categories are not supported" dialog with Cancel/OK — OK starts with app tokens only, Cancel aborts the start
- [ ] Allowlist with only unenforceable apps (desktop names / legacy categories-only): websites-only confirm dialog; decline aborts
- [ ] Card "Allows {n}" / "Blocks {n}" counts every Screen Time app individually (block mode: each category still counts as 1)
- [ ] Always Allowed app behavior recorded (expected: resists the shield)
- [ ] Fresh-install upgrade with pre-existing shield snapshot data: shield extension renders without crashing
- [ ] Save/edit/duplicate/import round-trips keep Allow mode; card shows "Allows N"

---

## 15. Desktop Allowlist (Allow-Mode Focus Spaces)

Same channel split as blocklist mode: **macOS Safari/Chrome/Brave/Edge** enforce
via Automation; **macOS Firefox + all Windows browsers** via the Digital Habits: Focus
extension. App allow-mode uses the in-process app watcher (macOS + Windows;
no Linux). Run the website checks once per channel.

Before manual checks, run the automated allowlist coverage: Tier 1 Category 14
(`Cmd+Shift+T`), Tier 2 Group H (`runIntegrationTests('full')`), and
`cargo test --lib` in `src-tauri`.

### Websites (per channel: Automation, then extension)

- [ ] Create allow-mode focus space (e.g. allow `github.com` only); card shows "Allows N"
- [ ] Start manual block: `github.com` loads; `reddit.com` redirects to the block page
- [ ] Block page shows allowlist copy ("not on your current allowlist") with the focus space's pill/emoji/countdown (`mode=allowlist` param)
- [ ] Two concurrent allowlists (e.g. `github.com` / `wikipedia.org`): both load, everything else blocked (union)
- [ ] Allowlist + blocklist overlap: blocklist blocking `github.com` runs alongside → `github.com` blocked (blocklist wins), block page attributes the blocklist space
- [ ] Pause allowlist → all sites usable; resume → allowlist semantics return (not blocklist)
- [ ] Schedule segment on an allowlist: enforcement flips at segment boundaries
- [ ] Stop all: browsing fully restored; parked block-page tabs recover (Automation channel)

### Apps (macOS and Windows)

- [ ] Start allow-mode space with 1–2 allowed apps while several non-allowed apps are open: every visible non-allowed app gets the "Let's go!" warning (allowed-app pills shown); nothing is quit before acknowledging
- [ ] Start with **no** closable apps open: intention-only overlay appears; "Let's go!" dismisses it with no countdown
- [ ] Mid-session: bring a non-allowed app frontmost → it is quit (30 s wrap-up then polite quit); background agents keep running
- [ ] Switch away from a warned non-allowed app before its quit lands → quit is aborted (no longer user-facing)
- [ ] Allowed apps and protected apps (Finder, Digital Habits: Blocker) are never targeted
- [ ] End/stop: no further quits; previously warned apps reopen normally

### Diagnostics

- [ ] Diagnostics view shows "Current enforcement" with the allow-mode entry, mode label, and allowed website union while an allowlist is active

---

## Sign-off

| Tester | Date | Version | Platform | Pass/Fail |
|--------|------|---------|----------|-----------|
|        |      |         |          |           |
