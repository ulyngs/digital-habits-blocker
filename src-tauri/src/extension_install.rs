// Force-install policies for the ReDD Focus browser extension.
//
// - **Chromium-family** (Chrome / Brave / Edge):
//   - macOS / Linux: drop a per-user "External Extensions" hint
//     (one-line JSON file under the browser's user data dir) — the
//     browser auto-installs from the Chrome Web Store on next launch.
//     Light touch: extension shows up in `chrome://extensions` like
//     a normal store install; user can disable / remove from the UI.
//     Trade-off: no auto-uninstall when ReDD Blocker goes away (user
//     keeps the extension until they remove it themselves).
//   - Windows: nested registry keys under
//     `HKCU\Software\Policies\<vendor>\<browser>\ExtensionSettings\<ext-id>`.
//     This IS a Mandatory-scope enterprise policy: silent force-
//     install, locked, "Managed by your organization" badge. ReDD
//     Block uninstall strips the keys and the browser auto-uninstalls
//     the extension on its next launch.
//
//   Why the asymmetry: Chromium's macOS policy loader treats user-
//   level CFPreferences (`~/Library/Preferences/<bundle-id>.plist`)
//   as Recommended-scope only. `installation_mode: force_installed`
//   requires Mandatory scope. The only Mandatory paths on macOS are
//   `/Library/Managed Preferences/...` (admin-only) and Configuration
//   Profiles (require System-Settings UI install + admin on Sonoma+).
//   We're a no-admin / no-helper app, so we fall back to External
//   Extensions on macOS. On Windows, HKCU\Software\Policies\* IS
//   Mandatory scope without admin, so the policy approach works.
//
//   ExtensionSettings doesn't have a field to auto-grant incognito
//   access — Chromium leaves that toggle user-controlled even for
//   fully-managed installs (open [Chromium bug since 2018](https://bugs.chromium.org/p/chromium/issues/detail?id=826712);
//   no fix shipped). Onboarding still has to nag once for "Allow in
//   Incognito" on Chromium browsers.
//
//   We clean up any stale ExtensionSettings entries from the prior
//   ReDD Blocker release on macOS install — that release tried the
//   policy approach before we discovered the Recommended-scope
//   limitation, and the leftover plist entries would otherwise
//   show forever in `chrome://policy` as ignored Recommended hints.
//
//   We also do a one-shot scrub of the `extensions.external_uninstalls`
//   tombstone in each Chromium profile's `Preferences` file. Chrome
//   adds an entry there whenever the user removes an externally-
//   installed extension, and from that point on the External
//   Extensions hint becomes a permanent no-op for that ID. The scrub
//   is gated by a marker file in the app-data dir so it runs exactly
//   once per ReDD Blocker install — re-installs after a deliberate user
//   removal are respected, but a fresh install (or a recovery from
//   an earlier failed-policy pass that left the user mid-loop) gets
//   a clean slate.
//
// - **Firefox**:
//   - macOS: write an `ExtensionSettings` entry to
//     `/Applications/Firefox.app/Contents/Resources/distribution/policies.json`.
//     Firefox treats this as a managed enterprise policy: on next launch
//     it silently force-installs the extension from AMO; the user sees
//     "Managed by your administrator" in `about:addons` and can't
//     disable / remove it from the UI. The policy ALSO auto-grants
//     private-browsing access via `private_browsing: true` (Firefox's
//     schema has this; Chromium's doesn't).
//
//     Earlier versions of this module sideloaded a signed XPI into
//     `~/Library/Application Support/Mozilla/Extensions/{guid}/`, but
//     Mozilla removed that mechanism in Firefox 74 (Oct 2019); the
//     directory still exists but Firefox no longer reads it.
//
//     On Windows, the `policies.json` equivalent lives at
//     `C:\Program Files\Mozilla Firefox\distribution\policies.json`
//     which requires admin elevation — so we don't use that path.
//   - Windows: nested registry keys under
//     `HKCU\Software\Policies\Mozilla\Firefox\ExtensionSettings\<addon-id>`.
//     Same mechanism as Chromium: HKCU\Software\Policies\* is
//     Mandatory-scope without admin. Firefox reads these keys on
//     launch, silently force-installs the extension from AMO, and
//     shows "Managed by your organization" in `about:addons`.
//     Unlike Chromium, Firefox's ExtensionSettings schema supports
//     `private_browsing` to auto-grant private-window access.
//
// Mirrors the structure of `native_host_install.rs` so the install /
// uninstall lifecycle hooks are symmetric.
//
// Safari is out of scope (native bundle handles its own extension).

use std::path::PathBuf;

use serde::Serialize;
// The Chromium external-update hint and its tests are the only users, and
// neither is compiled on Windows.
#[cfg(not(target_os = "windows"))]
use serde_json::json;

use crate::native_host_install::{CHROMIUM_EXT_ID, FIREFOX_EXT_ID};

/// Update URL the browser fetches the extension `.crx` from. The Chrome
/// Web Store URL works for Chrome and Brave directly.
pub const CHROMIUM_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";

/// Edge Add-ons store update URL. Once the extension is published on the
/// Edge store, this lets force-install work without the user toggling
/// "Allow extensions from other stores" in `edge://extensions`.
// TODO: publish ReDD Focus on the Edge Add-ons store and replace this
//       with the real Edge update URL. Until then, we fall back to the
//       Chrome Web Store URL (requires the "other stores" toggle).
pub const EDGE_UPDATE_URL: &str = CHROMIUM_UPDATE_URL;
// When published, replace the line above with:
// pub const EDGE_UPDATE_URL: &str = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

/// AMO URL Firefox fetches the XPI from when the policy is in place.
/// Always-redirects to the latest signed release.
pub const FIREFOX_AMO_XPI_URL: &str =
    "https://addons.mozilla.org/firefox/downloads/latest/digitalhabits-focus/latest.xpi";

#[derive(Debug, Clone, Copy, Serialize)]
pub enum BrowserTarget {
    Chrome,
    Brave,
    Edge,
}

impl BrowserTarget {
    fn all() -> [BrowserTarget; 3] {
        [
            BrowserTarget::Chrome,
            BrowserTarget::Brave,
            BrowserTarget::Edge,
        ]
    }

    /// macOS bundle id — used as the basename of the per-browser plist
    /// file at `~/Library/Preferences/<bundle-id>.plist` where Chromium
    /// reads enterprise policies (alongside its own user prefs).
    #[cfg(target_os = "macos")]
    fn bundle_id(self) -> &'static str {
        match self {
            BrowserTarget::Chrome => "com.google.Chrome",
            BrowserTarget::Brave => "com.brave.Browser",
            BrowserTarget::Edge => "com.microsoft.Edge",
        }
    }

    /// Per-browser policy plist path on macOS.
    #[cfg(target_os = "macos")]
    fn policy_plist_path(self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        Some(
            home.join("Library/Preferences")
                .join(format!("{}.plist", self.bundle_id())),
        )
    }

    /// HKCU registry path of the parent `ExtensionSettings` policy key
    /// on Windows. We write a child key per extension, so the full
    /// path for our entry is `<this>\<ext-id>` with `installation_mode`
    /// + `update_url` named values.
    #[cfg(target_os = "windows")]
    fn policy_extension_settings_root(self) -> &'static str {
        match self {
            BrowserTarget::Chrome => r"Software\Policies\Google\Chrome\ExtensionSettings",
            BrowserTarget::Brave => {
                r"Software\Policies\BraveSoftware\Brave-Browser\ExtensionSettings"
            }
            BrowserTarget::Edge => r"Software\Policies\Microsoft\Edge\ExtensionSettings",
        }
    }

    /// External Extensions hint dir on macOS / Linux (the active
    /// install path on those platforms — see file-level doc for why
    /// we don't use ExtensionSettings here). One JSON file per
    /// extension; browser auto-installs from the Web Store on launch.
    #[cfg(not(target_os = "windows"))]
    fn external_extensions_dir(self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        #[cfg(target_os = "macos")]
        {
            let p = match self {
                BrowserTarget::Chrome => {
                    "Library/Application Support/Google/Chrome/External Extensions"
                }
                BrowserTarget::Brave => {
                    "Library/Application Support/BraveSoftware/Brave-Browser/External Extensions"
                }
                BrowserTarget::Edge => {
                    "Library/Application Support/Microsoft Edge/External Extensions"
                }
            };
            Some(home.join(p))
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            let p = match self {
                BrowserTarget::Chrome => ".config/google-chrome/External Extensions",
                BrowserTarget::Brave => ".config/BraveSoftware/Brave-Browser/External Extensions",
                BrowserTarget::Edge => ".config/microsoft-edge/External Extensions",
            };
            Some(home.join(p))
        }
    }
}

/// `policies.json` path inside the Firefox app bundle on macOS. We
/// only target the standard `/Applications/Firefox.app` location —
/// users with Firefox in a non-standard place fall back to the
/// existing onboarding "Install in Firefox" link.
#[cfg(target_os = "macos")]
fn firefox_policies_json_path() -> PathBuf {
    PathBuf::from("/Applications/Firefox.app/Contents/Resources/distribution/policies.json")
}

/// Drop the install hint for every supported browser. Idempotent —
/// running it on every app launch keeps the hints in place and
/// re-creates them if the user removed any manually.
pub fn install() -> std::io::Result<()> {
    // macOS installs no hints at all: the Firefox extension is set up by hand
    // and the Chromium browsers are driven by Automation, not the extension.
    // (A `cfg(macos)` Firefox-policy block used to sit at the end of this
    // function, unreachable behind this early return — removed with the
    // restructure rather than left as dead code.)
    #[cfg(target_os = "macos")]
    {
        log::info!("extension_install::install() skipped on macOS — Firefox extension is manual");
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        log::info!("tcc-probe: extension_install::install() entered");
        for browser in BrowserTarget::all() {
            log::info!("tcc-probe: extension_install::install_chromium({browser:?}) start");
            if let Err(e) = install_chromium(browser) {
                log::warn!("extension-install hint for {browser:?} failed: {e}");
            }
            log::info!("tcc-probe: extension_install::install_chromium({browser:?}) done");
        }
        #[cfg(target_os = "windows")]
        if let Err(e) = install_firefox_registry() {
            log::warn!("extension-install Firefox registry policy failed: {e}");
        }
        #[cfg(not(target_os = "windows"))]
        {
            log::info!(
                "tcc-probe: extension_install::maybe_scrub_external_uninstalls_once() start"
            );
            maybe_scrub_external_uninstalls_once();
            log::info!("tcc-probe: extension_install::maybe_scrub_external_uninstalls_once() done");
            log::info!("tcc-probe: extension_install::install_firefox_policy() start");
            if let Err(e) = install_firefox_policy() {
                log::warn!("extension-install Firefox policy failed: {e}");
            }
            log::info!("tcc-probe: extension_install::install_firefox_policy() done");
        }
        log::info!("tcc-probe: extension_install::install() exited");
        Ok(())
    }
}

/// Remove the install hint for every supported browser. Safe to call
/// even if the hint was never written.
pub fn uninstall() -> std::io::Result<()> {
    for browser in BrowserTarget::all() {
        if let Err(e) = uninstall_chromium(browser) {
            log::warn!("extension-uninstall hint for {browser:?} failed: {e}");
        }
    }
    #[cfg(target_os = "macos")]
    if let Err(e) = uninstall_firefox_policy() {
        log::warn!("extension-uninstall Firefox policy failed: {e}");
    }
    #[cfg(target_os = "windows")]
    if let Err(e) = uninstall_firefox_registry() {
        log::warn!("extension-uninstall Firefox registry policy failed: {e}");
    }
    Ok(())
}

// ---- Chromium-family (Chrome / Brave / Edge) -------------------------------

/// Drop the External Extensions install hint for one Chromium browser.
pub fn install_chromium_hint(browser: BrowserTarget) -> std::io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        maybe_scrub_external_uninstalls_once();
        install_chromium(browser)
    }
    #[cfg(target_os = "windows")]
    install_chromium(browser)
}

#[cfg(not(target_os = "windows"))]
fn install_chromium(browser: BrowserTarget) -> std::io::Result<()> {
    // External Extensions hint: per-user JSON file under the browser's
    // user data dir. Browser auto-installs from the Chrome Web Store
    // on next launch. See the file-level doc for why we don't use
    // ExtensionSettings / `~/Library/Preferences/<bundle>.plist` on
    // macOS (Recommended-scope only; force-install needs Mandatory).
    let dir = browser
        .external_extensions_dir()
        .ok_or_else(|| std::io::Error::other("cannot resolve external-extensions dir"))?;

    // Skip if the parent (browser user-data dir) doesn't exist — no
    // point populating a hint for a browser that's never been
    // launched. The browser creates `External Extensions/` lazily on
    // first launch, so we may need to create it here. The parent
    // dir's existence is a good proxy for "browser has profile state
    // on this machine".
    let Some(parent) = dir.parent() else {
        return Err(std::io::Error::other(
            "external-extensions dir has no parent",
        ));
    };
    log::info!(
        "tcc-probe: about to exists() (cross-app) {} [browser={browser:?}]",
        parent.display()
    );
    if !parent.exists() {
        log::info!(
            "extension-install: skipping {browser:?} — no profile dir at {}",
            parent.display()
        );
        // Still try to clean up any stale failed-policy plist entry
        // — see comment on `cleanup_failed_policy_plist_entry`.
        cleanup_failed_policy_plist_entry(browser);
        return Ok(());
    }

    let path = dir.join(format!("{CHROMIUM_EXT_ID}.json"));
    let body = json!({ "external_update_url": CHROMIUM_UPDATE_URL });
    let desired = serde_json::to_vec_pretty(&body)?;

    // Idempotency: if the file already has the bytes we'd write, do
    // nothing. Avoids the macOS Sonoma+ "ReDD Blocker would like to
    // access data from other apps" TCC prompt that fires on every
    // write into another app's data dir, even when the write is a
    // no-op.
    log::info!(
        "tcc-probe: about to read (cross-app) {} [browser={browser:?}]",
        path.display()
    );
    if let Ok(existing) = std::fs::read(&path) {
        if existing == desired {
            log::info!(
                "extension-install: External Extensions hint already current for {browser:?} at {} (skip)",
                path.display()
            );
            cleanup_failed_policy_plist_entry(browser);
            return Ok(());
        }
    }

    log::info!(
        "tcc-probe: about to create_dir_all (cross-app) {} [browser={browser:?}]",
        dir.display()
    );
    std::fs::create_dir_all(&dir)?;
    log::info!(
        "tcc-probe: about to write (cross-app) {} [browser={browser:?}]",
        path.display()
    );
    std::fs::write(&path, &desired)?;
    log::info!(
        "extension-install: External Extensions hint written for {browser:?} at {}",
        path.display()
    );

    cleanup_failed_policy_plist_entry(browser);
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn uninstall_chromium(browser: BrowserTarget) -> std::io::Result<()> {
    let dir = browser
        .external_extensions_dir()
        .ok_or_else(|| std::io::Error::other("cannot resolve external-extensions dir"))?;
    let path = dir.join(format!("{CHROMIUM_EXT_ID}.json"));
    if path.exists() {
        std::fs::remove_file(&path)?;
        log::info!(
            "extension-uninstall: External Extensions hint removed for {browser:?} at {}",
            path.display()
        );
    }
    cleanup_failed_policy_plist_entry(browser);
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_chromium(browser: BrowserTarget) -> std::io::Result<()> {
    // ExtensionSettings policy: HKCU\Software\Policies\<vendor>\<browser>\ExtensionSettings\<ext-id>.
    // Mandatory-scope on Windows (HKCU\Software\Policies\* counts as
    // Mandatory without admin), so we get force-install + locked
    // install + auto-uninstall hygiene. On macOS the same approach
    // tops out at Recommended scope and Chromium ignores the
    // force-install directive — see `install_chromium` above.
    let our_key = format!(
        r"{}\{}",
        browser.policy_extension_settings_root(),
        CHROMIUM_EXT_ID
    );
    let update_url = match browser {
        BrowserTarget::Edge => EDGE_UPDATE_URL,
        _ => CHROMIUM_UPDATE_URL,
    };
    write_hkcu_named_value(&our_key, "installation_mode", "force_installed")?;
    write_hkcu_named_value(&our_key, "update_url", update_url)?;
    log::info!(
        "extension-install: ExtensionSettings policy written for {browser:?} at HKCU\\{our_key}"
    );
    Ok(())
}

#[cfg(target_os = "windows")]
fn uninstall_chromium(browser: BrowserTarget) -> std::io::Result<()> {
    let our_key = format!(
        r"{}\{}",
        browser.policy_extension_settings_root(),
        CHROMIUM_EXT_ID
    );
    let _ = delete_hkcu_key(&our_key);
    Ok(())
}

/// Strip the `ExtensionSettings.<ext-id>` entry from the per-browser
/// policy plist on macOS — only relevant for users upgrading from the
/// Earlier build that tried the policy approach before we
/// discovered Chromium treats user-level CFPreferences as Recommended
/// scope only. Without this cleanup, the entry would linger forever
/// in the user's plist, showing in `chrome://policy` as an ignored
/// Recommended hint. New installs are no-op (entry doesn't exist).
#[cfg(target_os = "macos")]
fn cleanup_failed_policy_plist_entry(browser: BrowserTarget) {
    let Some(plist_path) = browser.policy_plist_path() else {
        return;
    };
    // `~/Library/Preferences/<browser-bundle>.plist` is in OUR Preferences
    // dir but is registered to another app's bundle id, so `exists()` is
    // already a cross-app stat on Sonoma+.
    log::info!(
        "tcc-probe: about to exists() (cross-app plist) {} [browser={browser:?}]",
        plist_path.display()
    );
    if !plist_path.exists() {
        return;
    }
    log::info!(
        "tcc-probe: about to plist::Value::from_file (cross-app) {} [browser={browser:?}]",
        plist_path.display()
    );
    let Ok(mut data) = plist::Value::from_file(&plist_path) else {
        return;
    };
    let mut changed = false;
    if let Some(root) = data.as_dictionary_mut() {
        if let Some(ext_settings) = root
            .get_mut("ExtensionSettings")
            .and_then(|v| v.as_dictionary_mut())
        {
            if ext_settings.remove(CHROMIUM_EXT_ID).is_some() {
                changed = true;
                if ext_settings.is_empty() {
                    root.remove("ExtensionSettings");
                }
            }
        }
    }
    if changed {
        log::info!(
            "tcc-probe: about to plist::to_file_binary (cross-app) {} [browser={browser:?}]",
            plist_path.display()
        );
        if plist::to_file_binary(&plist_path, &data).is_ok() {
            log::info!(
                "extension-install: stripped stale (ignored) policy entry for {browser:?} from {}",
                plist_path.display()
            );
        }
    }
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn cleanup_failed_policy_plist_entry(_browser: BrowserTarget) {}

// ---- External-uninstalls tombstone scrub (macOS / Linux Chromium) ----------

/// Chromium adds the extension's ID to `extensions.external_uninstalls`
/// in a profile's `Preferences` file when the user removes an
/// extension that was installed via the External Extensions hint.
/// Once present, the tombstone makes the hint a permanent no-op for
/// that ID — Chrome silently refuses to ever re-install it from the
/// same external source.
///
/// At ReDD Blocker install time we want a one-shot scrub: clear the
/// tombstone (if any) from every Chromium profile so the hint can do
/// its job. We deliberately do NOT scrub on every launch — once the
/// user has actively removed the extension after install, that's a
/// signal we should respect, not fight.
///
/// "One-shot" is enforced via a marker file in our app-data dir. If
/// the marker is absent, we run the scrub for every supported browser
/// and then create the marker. Future launches see the marker and skip.
/// Bumping the marker name (`v1` → `v2`) re-runs the scrub for everyone
/// — handy if we ever need to recover from another mass-tombstoning
/// scenario in the wild.
///
/// No admin rights required: Preferences lives in the user's profile
/// dir under `~/Library/Application Support/<browser>/<profile>/`.
#[cfg(not(target_os = "windows"))]
fn maybe_scrub_external_uninstalls_once() {
    let Some(marker) = scrub_marker_path() else {
        return;
    };
    if marker.exists() {
        return;
    }
    for browser in BrowserTarget::all() {
        scrub_external_uninstalls_tombstone(browser);
    }
    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Best-effort marker creation. If this fails (e.g. read-only
    // filesystem) we'll re-scrub next launch — harmless idempotent.
    let _ = std::fs::write(&marker, b"");
}

#[cfg(not(target_os = "windows"))]
fn scrub_marker_path() -> Option<PathBuf> {
    // `data_local_dir()` is `~/Library/Application Support` on macOS
    // and `~/.local/share` on Linux. We park our marker under the
    // app's bundle id so we don't pollute the parent dir.
    let base = dirs::data_local_dir()?;
    Some(
        base.join("com.reddblock")
            .join("external-uninstalls-scrubbed.v1"),
    )
}

#[cfg(not(target_os = "windows"))]
fn scrub_external_uninstalls_tombstone(browser: BrowserTarget) {
    let Some(ext_dir) = browser.external_extensions_dir() else {
        return;
    };
    // The user-data dir is the parent of `External Extensions/`. Each
    // profile under it (Default, Profile 1, Profile 2, …) has its own
    // Preferences file; we visit them all.
    let Some(user_data_dir) = ext_dir.parent() else {
        return;
    };
    log::info!(
        "tcc-probe: about to read_dir (cross-app) {} [browser={browser:?}]",
        user_data_dir.display()
    );
    let Ok(entries) = std::fs::read_dir(user_data_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let prefs_path = entry.path().join("Preferences");
        log::info!(
            "tcc-probe: about to is_file() (cross-app) {} [browser={browser:?}]",
            prefs_path.display()
        );
        if !prefs_path.is_file() {
            continue;
        }
        if let Err(e) = strip_tombstone_from_prefs(&prefs_path) {
            log::warn!(
                "extension-install: tombstone scrub failed for {}: {e}",
                prefs_path.display()
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn strip_tombstone_from_prefs(prefs_path: &std::path::Path) -> std::io::Result<()> {
    log::info!(
        "tcc-probe: about to read_to_string (cross-app prefs) {}",
        prefs_path.display()
    );
    let raw = std::fs::read_to_string(prefs_path)?;
    let mut data: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut changed = false;
    if let Some(arr) = data
        .pointer_mut("/extensions/external_uninstalls")
        .and_then(|v| v.as_array_mut())
    {
        let before = arr.len();
        arr.retain(|v| v.as_str() != Some(CHROMIUM_EXT_ID));
        if arr.len() != before {
            changed = true;
        }
    }
    if changed {
        // Write atomically (temp file + rename) — Chrome does the
        // same when persisting Preferences, so a partial-write that
        // gets read mid-update would otherwise corrupt the profile.
        //
        // Race with a live Chrome process: if Chrome is running our
        // edit can be clobbered the next time it flushes Preferences,
        // and the marker has now been written so we won't retry. The
        // documented expectation is that this scrub fires before the
        // user opens Chrome at login — the typical case for a launch-
        // at-login app. If the race ever bites in practice we can
        // bump the marker to `v2` and re-scrub everyone.
        let tmp = prefs_path.with_extension("reddblock.tmp");
        log::info!(
            "tcc-probe: about to write (cross-app prefs tmp) {}",
            tmp.display()
        );
        std::fs::write(&tmp, serde_json::to_vec(&data)?)?;
        log::info!(
            "tcc-probe: about to rename (cross-app prefs) {} -> {}",
            tmp.display(),
            prefs_path.display()
        );
        std::fs::rename(&tmp, prefs_path)?;
        log::info!(
            "extension-install: cleared external-uninstalls tombstone for {CHROMIUM_EXT_ID} at {}",
            prefs_path.display()
        );
    }
    Ok(())
}

// ---- Firefox (enterprise policies, macOS only) -----------------------------

/// Force-install the ReDD Focus extension via Firefox enterprise
/// policies. Writes (or merges into) `policies.json` inside the
/// Firefox app bundle's `Resources/distribution/` directory. Firefox
/// reads this file on launch and treats listed extensions as managed
/// — silently auto-installs from AMO, locks them ("Managed by your
/// administrator" badge), and prevents user removal.
///
/// Idempotent: re-running merges our entry into whatever's already
/// there. Preserves any other policies the user / admin has set.
///
/// Skips silently if:
/// - Firefox.app isn't at `/Applications/Firefox.app` (custom-install
///   users fall back to the existing onboarding flow).
/// - We don't have write access to the bundle (e.g. non-admin macOS
///   account).
#[cfg(target_os = "macos")]
#[allow(dead_code)] // Linux path only; macOS sets Firefox up manually
fn install_firefox_policy() -> std::io::Result<()> {
    let policies_path = firefox_policies_json_path();
    let Some(distribution_dir) = policies_path.parent() else {
        return Err(std::io::Error::other("policies.json path has no parent"));
    };
    let Some(resources_dir) = distribution_dir.parent() else {
        return Err(std::io::Error::other("distribution dir has no parent"));
    };

    log::info!(
        "tcc-probe: about to exists() (Firefox bundle) {}",
        resources_dir.display()
    );
    if !resources_dir.exists() {
        log::info!(
            "extension-install: Firefox skipped — bundle Resources dir missing at {}",
            resources_dir.display()
        );
        return Ok(());
    }

    // Best-effort `mkdir -p distribution/`. Returns Err if we lack
    // permission (managed Mac, non-admin user) — log + skip rather
    // than fail the whole install round.
    log::info!(
        "tcc-probe: about to create_dir_all (Firefox bundle) {}",
        distribution_dir.display()
    );
    if let Err(e) = std::fs::create_dir_all(distribution_dir) {
        log::warn!(
            "extension-install: Firefox skipped — cannot create {}: {e}",
            distribution_dir.display()
        );
        return Ok(());
    }

    // Read existing policies.json (if any) and merge in our entry.
    // Preserves anything else IT / a previous tool put there.
    log::info!(
        "tcc-probe: about to exists() (Firefox policies) {}",
        policies_path.display()
    );
    let mut data = if policies_path.exists() {
        log::info!(
            "tcc-probe: about to read_to_string (Firefox policies) {}",
            policies_path.display()
        );
        let raw = std::fs::read_to_string(&policies_path)?;
        serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_else(|e| {
            log::warn!(
                "extension-install: existing policies.json at {} is invalid JSON ({e}); rewriting",
                policies_path.display()
            );
            json!({})
        })
    } else {
        json!({})
    };

    if !data.is_object() {
        data = json!({});
    }
    let root = data.as_object_mut().unwrap();
    let policies = root
        .entry("policies".to_string())
        .or_insert_with(|| json!({}));
    if !policies.is_object() {
        *policies = json!({});
    }
    let policies = policies.as_object_mut().unwrap();
    let extension_settings = policies
        .entry("ExtensionSettings".to_string())
        .or_insert_with(|| json!({}));
    if !extension_settings.is_object() {
        *extension_settings = json!({});
    }
    let extension_settings = extension_settings.as_object_mut().unwrap();
    extension_settings.insert(
        FIREFOX_EXT_ID.to_string(),
        json!({
            "installation_mode": "force_installed",
            "install_url": FIREFOX_AMO_XPI_URL,
            // Auto-grant private-browsing access (and lock the toggle).
            // Without this, the extension installs but users still
            // have to walk through `about:addons` → ReDD Focus →
            // Details → Allow in Private Windows. Same trade as the
            // install itself: more friction up front, but consistent
            // enforcement across normal + private windows.
            "private_browsing": true,
        }),
    );

    let pretty = serde_json::to_string_pretty(&data)?;

    // Idempotency: skip the write if existing file already matches.
    // Writing into /Applications/Firefox.app/... requires the macOS
    // App Management TCC permission; even a no-op write triggers the
    // prompt. Reading does not.
    log::info!(
        "tcc-probe: about to read_to_string (Firefox policies, idempotency check) {}",
        policies_path.display()
    );
    if let Ok(existing) = std::fs::read_to_string(&policies_path) {
        if existing == pretty {
            log::info!(
                "extension-install: Firefox policy already current at {} (skip)",
                policies_path.display()
            );
            return Ok(());
        }
    }

    log::info!(
        "tcc-probe: about to write (Firefox policies) {}",
        policies_path.display()
    );
    std::fs::write(&policies_path, pretty)?;
    log::info!(
        "extension-install: Firefox policy written at {}",
        policies_path.display()
    );
    Ok(())
}

/// Strip our `ExtensionSettings` entry from `policies.json`. If
/// removing our entry leaves the file empty, delete it (and the
/// `distribution/` directory if empty too) so a clean uninstall
/// leaves no trace.
#[cfg(target_os = "macos")]
fn uninstall_firefox_policy() -> std::io::Result<()> {
    let policies_path = firefox_policies_json_path();
    if !policies_path.exists() {
        return Ok(());
    }

    let raw = std::fs::read_to_string(&policies_path)?;
    let mut data: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => {
            // Not our JSON to clean up. Leave alone.
            return Ok(());
        }
    };

    let mut wrote_empty = false;
    if let Some(root) = data.as_object_mut() {
        if let Some(policies) = root.get_mut("policies").and_then(|v| v.as_object_mut()) {
            if let Some(ext_settings) = policies
                .get_mut("ExtensionSettings")
                .and_then(|v| v.as_object_mut())
            {
                ext_settings.remove(FIREFOX_EXT_ID);
                if ext_settings.is_empty() {
                    policies.remove("ExtensionSettings");
                }
            }
            if policies.is_empty() {
                root.remove("policies");
            }
        }
        wrote_empty = root.is_empty();
    }

    if wrote_empty {
        std::fs::remove_file(&policies_path)?;
        // Try to remove the distribution dir too if we're the only
        // thing in it. `remove_dir` only succeeds when empty, so
        // failure here is silent — anyone else's content stays.
        if let Some(dist_dir) = policies_path.parent() {
            let _ = std::fs::remove_dir(dist_dir);
        }
        log::info!(
            "extension-uninstall: Firefox policy file removed at {}",
            policies_path.display()
        );
    } else {
        let pretty = serde_json::to_string_pretty(&data)?;
        std::fs::write(&policies_path, pretty)?;
        log::info!(
            "extension-uninstall: Firefox policy entry stripped from {}",
            policies_path.display()
        );
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn write_hkcu_named_value(path: &str, value_name: &str, value: &str) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    unsafe {
        let mut hkey: HKEY = HKEY::default();
        let subkey = to_wide(path);
        let status = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        );
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::other(format!(
                "RegCreateKeyExW failed: {status:?}"
            )));
        }
        let name_wide = to_wide(value_name);
        let data_wide = to_wide(value);
        let bytes_len = (data_wide.len() * 2) as u32;
        let data_bytes =
            std::slice::from_raw_parts(data_wide.as_ptr() as *const u8, bytes_len as usize);
        let status = RegSetValueExW(
            hkey,
            PCWSTR(name_wide.as_ptr()),
            Some(0),
            REG_SZ,
            Some(data_bytes),
        );
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::other(format!(
                "RegSetValueExW failed: {status:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn delete_hkcu_key(path: &str) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};

    unsafe {
        let wide = to_wide(path);
        let status = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr()));
        if status != ERROR_SUCCESS {
            return Err(std::io::Error::other(format!(
                "RegDeleteKeyW failed: {status:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

// ---- Firefox (Windows registry policy) --------------------------------------

/// Force-install the ReDD Focus extension in Firefox via Windows
/// registry policies. Firefox reads `ExtensionSettings` from
/// `HKCU\Software\Policies\Mozilla\Firefox\ExtensionSettings\<addon-id>`
/// on launch — same Mandatory-scope mechanism as Chromium on Windows.
/// Unlike Chromium, Firefox's schema supports `private_browsing` to
/// auto-grant private-window access (no manual toggle needed).
///
/// Idempotent: re-running overwrites the same keys with the same values.
#[cfg(target_os = "windows")]
fn install_firefox_registry() -> std::io::Result<()> {
    let our_key = format!(
        r"Software\Policies\Mozilla\Firefox\ExtensionSettings\{}",
        FIREFOX_EXT_ID
    );
    write_hkcu_named_value(&our_key, "installation_mode", "force_installed")?;
    write_hkcu_named_value(&our_key, "install_url", FIREFOX_AMO_XPI_URL)?;
    // Auto-grant private-browsing access so the extension works in
    // private windows without the user toggling it in about:addons.
    // Firefox treats any non-empty REG_SZ as truthy for boolean policy
    // fields; "true" is the canonical spelling.
    write_hkcu_named_value(&our_key, "private_browsing", "true")?;
    log::info!("extension-install: Firefox registry policy written at HKCU\\{our_key}");
    Ok(())
}

/// Remove the Firefox extension policy keys from the registry.
#[cfg(target_os = "windows")]
fn uninstall_firefox_registry() -> std::io::Result<()> {
    let our_key = format!(
        r"Software\Policies\Mozilla\Firefox\ExtensionSettings\{}",
        FIREFOX_EXT_ID
    );
    let _ = delete_hkcu_key(&our_key);
    Ok(())
}

/// Tauri command — exposed for manual re-trigger from the UI (e.g. an
/// onboarding "Reinstall hints" button) and for tests. The startup
/// auto-install in `lib.rs::run` is marker-gated to one-shot per
/// machine; this command always runs, ignoring the marker, and also
/// re-drops the marker on success so a future startup stays silent.
#[tauri::command]
pub fn install_extension_hints() -> Result<(), String> {
    let result = install().map_err(|e| e.to_string());
    if result.is_ok() {
        mark_startup_install_done();
    }
    result
}

#[tauri::command]
pub fn uninstall_extension_hints() -> Result<(), String> {
    uninstall().map_err(|e| e.to_string())
}

/// Path of the marker file that gates the startup auto-install. Lives
/// under our own app-data dir (not inside any other app's territory)
/// so creating/reading it never touches another app's data and never
/// triggers a TCC prompt.
fn startup_install_marker_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir()?;
    Some(
        base.join("com.reddblock")
            .join("extension-hints-installed.v1"),
    )
}

/// `true` if the startup auto-install has already run (successfully)
/// on this machine. Used by `lib.rs::run` to skip the full sweep on
/// every launch.
pub fn startup_install_already_done() -> bool {
    startup_install_marker_path()
        .map(|p| p.exists())
        .unwrap_or(false)
}

/// Drop the marker after a successful startup auto-install. Best-effort
/// — if the write fails (e.g. read-only filesystem) the next launch
/// will retry the install, which is harmless since the per-browser
/// writes are themselves idempotent.
pub fn mark_startup_install_done() {
    let Some(path) = startup_install_marker_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, b"");
}
