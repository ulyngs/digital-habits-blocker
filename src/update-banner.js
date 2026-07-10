// Update banner: release-notes panel, download button, version check.
// Extracted verbatim from app.js.
import { state } from './state.js';
import { message } from '@tauri-apps/plugin-dialog';
import { tauriAPI, openUrl } from './tauri-api.js';
import { tSettings, tSettingsFmt } from './i18n.js';
import {
    resolveReleaseNotesForVersion,
    renderReleaseNotesHtml,
    releaseNotesHasContent,
    filterReleaseNotesForPlatform,
} from './changelog.js';

// Compare semver versions - returns true if versionA > versionB
export function isVersionHigher(versionA, versionB) {
    const partsA = versionA.split('.').map(Number);
    const partsB = versionB.split('.').map(Number);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const a = partsA[i] || 0;
        const b = partsB[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false; // Equal versions
}

/** Key in latest-versions.json — iOS uses its own release line, not desktop macos. */
export function getLatestVersionPlatformKey() {
    if (state.isIOS) return 'ios';
    if (state.isAndroid) return 'android';
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    return isMac ? 'macos' : 'windows';
}

export async function resolveMicrosoftStorePackage() {
    if (state.isMicrosoftStorePackage !== null) {
        return state.isMicrosoftStorePackage;
    }
    if (!document.body.classList.contains('windows')) {
        state.isMicrosoftStorePackage = false;
        return false;
    }
    try {
        state.isMicrosoftStorePackage = !!(await tauriAPI.isMicrosoftStorePackage());
    } catch (e) {
        console.warn('[Update] is_microsoft_store_package failed:', e);
        state.isMicrosoftStorePackage = false;
    }
    return state.isMicrosoftStorePackage;
}

export function updateBannerWhatsNewButtonHtml() {
    return `<span>${tSettings('updateBannerWhatsNew')}</span><svg class="update-banner-whats-new-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"></polyline></svg>`;
}

export function resetUpdateBannerWhatsNewPanel(whatsNewBtn, notesPanel, notesContent) {
    whatsNewBtn?.classList.remove('open');
    whatsNewBtn?.setAttribute('aria-expanded', 'false');
    notesPanel?.classList.add('hidden');
    if (notesContent) notesContent.innerHTML = '';
}

export function applyUpdateBannerReleaseNotes(notes, whatsNewBtn, notesPanel, notesContent) {
    const filtered = filterReleaseNotesForPlatform(notes, getLatestVersionPlatformKey());
    if (!releaseNotesHasContent(filtered) || !whatsNewBtn || !notesPanel || !notesContent) {
        whatsNewBtn?.classList.add('hidden');
        resetUpdateBannerWhatsNewPanel(whatsNewBtn, notesPanel, notesContent);
        return;
    }
    whatsNewBtn.innerHTML = updateBannerWhatsNewButtonHtml();
    whatsNewBtn.classList.remove('hidden');
    notesContent.innerHTML = renderReleaseNotesHtml(filtered);
}

export function normalizeReleaseVersion(version) {
    return String(version).replace(/^v/i, '').trim();
}

let updateDownloadProgressUnlisten = null;
export let updateDownloadInProgress = false;

export function getUpdateDownloadCtaLabel() {
    return tSettings('updateBannerCta');
}

export function getUpdateDownloadButtonLabel(state, percent = null) {
    if (state === 'opening') return tSettings('updateBannerOpeningInstaller');
    if (state === 'downloading') {
        if (typeof percent === 'number') {
            return tSettingsFmt('updateBannerDownloadingFmt', { percent });
        }
        return tSettings('updateBannerDownloading');
    }
    return getUpdateDownloadCtaLabel();
}

export function setUpdateDownloadButtonState(state, percent = null) {
    const btn = document.getElementById('update-banner-link');
    if (!btn) return;
    btn.textContent = getUpdateDownloadButtonLabel(state, percent);
    btn.disabled = state === 'downloading' || state === 'opening';
    btn.setAttribute('aria-busy', state === 'downloading' || state === 'opening' ? 'true' : 'false');
}

export function resetUpdateDownloadButtonState() {
    updateDownloadInProgress = false;
    setUpdateDownloadButtonState('idle');
}

export async function ensureUpdateDownloadProgressListener() {
    if (updateDownloadProgressUnlisten) return;
    updateDownloadProgressUnlisten = await tauriAPI.onUpdateDownloadProgress((event) => {
        const percent = event?.payload?.percent;
        if (updateDownloadInProgress) {
            setUpdateDownloadButtonState('downloading', typeof percent === 'number' ? percent : null);
        }
    });
}

export async function startUpdateDownload(latestVersion) {
    const btn = document.getElementById('update-banner-link');
    if (!btn || btn.disabled || updateDownloadInProgress) return;

    const version = normalizeReleaseVersion(latestVersion);
    updateDownloadInProgress = true;
    setUpdateDownloadButtonState('downloading', 0);

    try {
        await ensureUpdateDownloadProgressListener();
        await tauriAPI.downloadAndRunUpdate(version);
        setUpdateDownloadButtonState('opening');
        resetUpdateDownloadButtonState();
        if (state.isMacOSDesktop) {
            try {
                await message(tSettings('updateBannerInstallerOpened'), {
                    title: tSettings('updateBannerInstallerOpenedTitle'),
                    kind: 'info',
                });
            } catch {
                /* dialog unavailable */
            }
        }
    } catch (err) {
        console.error('[Update] In-app download failed:', err);
        resetUpdateDownloadButtonState();
        try {
            await message(
                `${tSettings('updateBannerDownloadFailed')}\n\n${String(err?.message || err || '')}`.trim(),
                { title: tSettings('updateBannerDownloadFailedTitle'), kind: 'error' },
            );
        } catch {
            /* dialog unavailable */
        }
    }
}

export function wireUpdateBannerDownloadLink(latestVersion, pkgBytes = null) {
    const btn = document.getElementById('update-banner-link');
    if (!btn) return;

    btn.dataset.latestVersion = latestVersion;
    if (pkgBytes) {
        btn.dataset.pkgBytes = String(pkgBytes);
    } else {
        delete btn.dataset.pkgBytes;
    }
    resetUpdateDownloadButtonState();

    if (!btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            const version = btn.dataset.latestVersion || latestVersion;
            void startUpdateDownload(version);
        });
    }
}

export function alignUpdateBannerLayout() {
    const banner = document.getElementById('update-banner');
    if (!banner || banner.classList.contains('hidden')) return;

    const title = document.getElementById('main-blocklists-title');
    const settingsBtn = document.getElementById('settings-btn')
        || document.getElementById('settings-btn-stack');
    const headerRow = banner.querySelector('.update-banner-header-row');
    if (!headerRow) return;

    banner.style.removeProperty('--update-banner-info-inset');
    banner.style.removeProperty('--update-banner-dismiss-inset');

    if (!title || !settingsBtn) return;

    const rowRect = headerRow.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const settingsRect = settingsBtn.getBoundingClientRect();

    const infoInset = Math.max(0, Math.round(titleRect.left - rowRect.left));
    const dismissInset = Math.max(0, Math.round(rowRect.right - settingsRect.right));

    banner.style.setProperty('--update-banner-info-inset', `${infoInset}px`);
    banner.style.setProperty('--update-banner-dismiss-inset', `${dismissInset}px`);
}

export function scheduleUpdateBannerLayout() {
    requestAnimationFrame(() => {
        requestAnimationFrame(alignUpdateBannerLayout);
    });
}

let updateBannerLayoutListenerBound = false;

export function ensureUpdateBannerLayoutListeners() {
    if (updateBannerLayoutListenerBound) return;
    updateBannerLayoutListenerBound = true;
    window.addEventListener('resize', scheduleUpdateBannerLayout, { passive: true });
    window.visualViewport?.addEventListener('resize', scheduleUpdateBannerLayout, { passive: true });
}

export async function showUpdateBanner(latestVersion, currentVersion = '', { pkgBytes = null } = {}) {
    const banner = document.getElementById('update-banner');
    const versionEl = document.getElementById('update-banner-version');
    const currentEl = document.getElementById('update-banner-current');
    const dismissBtn = document.getElementById('update-banner-dismiss');
    const whatsNewBtn = document.getElementById('update-banner-whats-new');
    const notesPanel = document.getElementById('update-banner-notes');
    const notesContent = document.getElementById('update-banner-notes-content');

    if (!banner || !versionEl) return;

    versionEl.textContent = latestVersion;
    wireUpdateBannerDownloadLink(latestVersion, pkgBytes);
    if (currentEl) {
        if (currentVersion) {
            currentEl.textContent = tSettingsFmt('updateBannerCurrentFmt', { version: currentVersion });
            currentEl.classList.remove('hidden');
        } else {
            currentEl.textContent = '';
            currentEl.classList.add('hidden');
        }
    }
    banner.classList.remove('hidden');
    whatsNewBtn?.classList.add('hidden');
    resetUpdateBannerWhatsNewPanel(whatsNewBtn, notesPanel, notesContent);

    const notes = await resolveReleaseNotesForVersion(latestVersion);
    applyUpdateBannerReleaseNotes(notes, whatsNewBtn, notesPanel, notesContent);

    if (dismissBtn && !dismissBtn.dataset.wired) {
        dismissBtn.dataset.wired = '1';
        dismissBtn.addEventListener('click', () => {
            banner.classList.add('hidden');
        });
    }

    if (whatsNewBtn && !whatsNewBtn.dataset.wired) {
        whatsNewBtn.dataset.wired = '1';
        whatsNewBtn.addEventListener('click', () => {
            const isOpen = whatsNewBtn.classList.toggle('open');
            notesPanel?.classList.toggle('hidden', !isOpen);
            whatsNewBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
    }

    ensureUpdateBannerLayoutListeners();
    scheduleUpdateBannerLayout();
}

// Check if a newer app version is available and show update banner.
// Desktop-only: Android/iOS update via their app stores. The compile-time
// guard makes this a no-op on Android and lets Rollup drop the transitive
// update-banner UI chain — including changelog.js and the bundled
// changelog.md (~57 KB of otherwise-unreachable startup parse).
export async function checkForAppUpdate() {
    if (__ANDROID_BUILD__) return;
    if (await resolveMicrosoftStorePackage()) {
        return;
    }
    try {
        const currentVersion = await tauriAPI.getAppVersion();
        if (!currentVersion) return;

        const response = await fetch(`https://ulyngs.github.io/redd-block/latest-versions.json?t=${Date.now()}`);
        const manifest = await response.json();
        const platformKey = getLatestVersionPlatformKey();
        const latestVersion = manifest[platformKey];
        const pkgBytes = platformKey === 'macos' ? manifest.sizeBytes?.macosPkg : null;

        if (latestVersion && isVersionHigher(latestVersion, currentVersion)) {
            await showUpdateBanner(latestVersion, currentVersion, { pkgBytes });
        }
    } catch (e) {
        // Silently fail if offline
        console.log('[Update] Could not check for updates:', e.message);
    }
}

if (import.meta.env.DEV) {
    /** Dev only: `previewUpdateBanner('3.5.0')` in the webview console. */
    window.previewUpdateBanner = async (version = '99.0.0', currentVersion = '3.3.0') => {
        const normalized = String(version).replace(/^v/i, '').trim();
        await showUpdateBanner(normalized, String(currentVersion).replace(/^v/i, '').trim());
        console.log(`[dev] Update banner preview for v${normalized}`);
    };
}
