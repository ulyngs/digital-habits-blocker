// Settings surface: help links, helper status, diagnostics modal, grace
// period, override-all, and in-app uninstall flows. Extracted verbatim from app.js.
import { state } from './state.js';
import { getChallengeController } from './challenge-controller.js';
import { startHelperUiRefreshLoop, stopHelperUiRefreshLoop, isModalVisible } from './modal-manager.js';
import { saveData, updateHostsFile } from './persistence.js';
import { render } from './render.js';
import { handleBlocklistSelect } from './confirm-modals.js';
import { updateBlockedApps, openExternal, isHelperInstallCancelled, checkHelperStatus, requestScreentimeAuth } from './blocking-platform.js';
import { attachCopyChipHandlers, extensionsUrlChipHtml, restartOnboardingFromSettings, BROWSER_STORE_LINKS, MAC_BLOCKING_METHOD_KEYS, browserBlockingMethod, browserIconUrl, browserUsesAutomation, lastOnboardingState, openExtensionSetupOverlay, updateGraceSettingLock } from './enforcement.js';
import { hasAnyBlockingStateToClear, hasAnyEnforcedBlocks, isOneOffBlockStillActive, refreshDesktopHelperStatus, scheduleCanStillBecomeActive } from './schedule-engine.js';
import { tauriAPI, openUrl } from './tauri-api.js';
import { syncDefaultPauseSettingUi } from './pause-default.js';
import { tSettings, tSettingsFmt, getSettingsLanguage } from './i18n.js';
import { invoke } from '@tauri-apps/api/core';
import { ask, message } from '@tauri-apps/plugin-dialog';
import logoReddFocusUrl from './images/logo-reddfocus.svg';
import { escapeHtml } from './utils.js';
import { getDifficultyTypingCharCount, getMaxOverrideCharsForType } from './override-challenge.js';
import {
    setLanguagePickerOpen,
    WINDOWS_APPS_SETTINGS_URI,
} from './app.js';

export function setupHelpMenuLinks() {
    tauriAPI.onMenuHelpReportIssue(() => {
        openExternal('https://github.com/ulyngs/digital-habits-blocker/issues');
    }).catch(() => { });

    tauriAPI.onMenuHelpContactUs(() => {
        openExternal('mailto:team@digitalhabits.org');
    }).catch(() => { });

    tauriAPI.onMenuHelpWhoWeAre(() => {
        openExternal('https://digitalhabits.org/#team-anchor');
    }).catch(() => { });
}

// Setup Helper Settings in the settings modal
export function setupHelperSettings() {
    if (state.isIOS || state.isAndroid) return;
    const statusIndicator = document.getElementById('helper-status-indicator');
    const cleanHostsBtn = document.getElementById('clean-hosts-btn');

    // Update helper status when settings modal opens
    ['settings-btn', 'settings-btn-stack']
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .forEach((settingsBtn) => {
            settingsBtn.addEventListener('click', () => {
                updateHelperStatusIndicator();
                updateCleanHostsBtnState();
                startHelperUiRefreshLoop();
            });
        });

    // Clean hosts file button
    if (cleanHostsBtn && !cleanHostsBtn._listenerAdded) {
        cleanHostsBtn._listenerAdded = true;
        cleanHostsBtn.addEventListener('click', async () => {
            if (cleanHostsBtn.disabled) return;

            const confirmed = await ask(
                'This will remove all Digital Habits: Blocker entries from your system\'s hosts file. ' +
                'Only use this if websites remain blocked after all blocks have been stopped.\n\n' +
                'Your computer may ask for your password or show a security prompt.',
                { title: 'Clean hosts file?', kind: 'warning' }
            );
            if (!confirmed) return;

            cleanHostsBtn.disabled = true;
            const originalHTML = cleanHostsBtn.innerHTML;
            cleanHostsBtn.innerHTML = '<span class="btn-spinner"></span>Cleaning...';

            try {
                const result = await tauriAPI.cleanHostsFile();
                if (result.success) {
                    await message('Hosts file cleaned successfully. If websites were still blocked, they should now be accessible.', { title: 'Done', kind: 'info' });
                } else {
                    await message('Failed to clean hosts file: ' + (result.error || 'Unknown error'), { title: 'Error', kind: 'error' });
                }
            } catch (e) {
                console.error('Error cleaning hosts file:', e);
                await message('Error cleaning hosts file: ' + e.message, { title: 'Error', kind: 'error' });
            } finally {
                cleanHostsBtn.disabled = false;
                cleanHostsBtn.innerHTML = originalHTML;
                updateCleanHostsBtnState();
            }
        });
    }

}

export function getHelperStatusDisplay(status) {
    const isRunning = !!status.running;
    const needsUpdate = isRunning && !status.version_ok;
    const installedButStopped = !!(status.installed && !isRunning);
    const enforcingNow = isRunning && status.version_ok && isDesktopBlockingEnforcedNow();

    if (isRunning && status.version_ok) {
        return {
            helperReady: true,
            indicatorClass: 'running',
            statusKey: enforcingNow ? 'helperStatusActive' : 'helperStatusIdle',
            showUpdate: false,
            showRemove: true,
            removeTitle: '',
            reachable: true,
        };
    }

    if (needsUpdate) {
        return {
            helperReady: false,
            indicatorClass: 'running',
            statusKey: 'helperStatusUpdateAvailable',
            showUpdate: true,
            showRemove: true,
            removeTitle: '',
            reachable: true,
        };
    }

    if (installedButStopped) {
        return {
            helperReady: false,
            indicatorClass: 'stopped',
            statusKey: 'helperStatusInstalledNotReachable',
            showUpdate: false,
            showRemove: true,
            removeTitle: tSettings('helperRemoveStaleHint'),
            reachable: false,
        };
    }

    return {
        helperReady: false,
        indicatorClass: 'stopped',
        statusKey: 'helperStatusNotInstalled',
        showUpdate: false,
        showRemove: false,
        removeTitle: '',
        reachable: false,
    };
}

export function logHelperRemovalFallback(result) {
    if (result?.error) {
        console.warn('[helper-uninstall] Fallback cleanup used:', result.error);
    }
}


export async function confirmHelperRemoved() {
    const status = await refreshDesktopHelperStatus();
    const removed = !(status?.installed || status?.running);

    await updateHelperStatusIndicator().catch(() => { });
    await checkHelperStatus().catch(() => { });

    if (!removed) {
        return {
            removed: false,
            status,
            error: 'Digital Habits: Blocker could not confirm that the helper was fully removed. It still appears to be installed.'
        };
    }

    state.helperAvailable = false;
    return { removed: true, status };
}

export async function uninstallHelperAndConfirmRemoved() {
    const result = await tauriAPI.uninstallHelper();
    if (!result.success) {
        return {
            success: false,
            error: result.error || 'Unknown error'
        };
    }

    logHelperRemovalFallback(result);

    const confirmation = await confirmHelperRemoved();
    if (!confirmation.removed) {
        return {
            success: false,
            error: confirmation.error
        };
    }

    return {
        success: true,
        usedFallback: !!result.error
    };
}

export function isDesktopBlockingEnforcedNow() {
    if (state.isIOS || state.isAndroid) return false;
    return hasAnyEnforcedBlocks();
}

// Update helper status indicator in settings modal
export async function updateHelperStatusIndicator() {
    const statusIndicator = document.getElementById('helper-status-indicator');
    if (!statusIndicator) return;

    const statusText = statusIndicator.querySelector('.status-text');
    const updateBtn = document.getElementById('update-helper-btn');

    try {
        const status = await refreshDesktopHelperStatus();
        const helperDisplay = getHelperStatusDisplay(status);
        state.helperAvailable = helperDisplay.helperReady;

        statusIndicator.classList.remove('running', 'stopped');
        statusIndicator.classList.add(helperDisplay.indicatorClass);
        statusText.textContent = tSettings(helperDisplay.statusKey);

        // Show/hide Update Helper button
        if (updateBtn) {
            updateBtn.style.display = helperDisplay.showUpdate ? 'flex' : 'none';

            // Wire up click handler (only once)
            if (!updateBtn._listenerAdded) {
                updateBtn._listenerAdded = true;
                updateBtn.addEventListener('click', async () => {
                    updateBtn.disabled = true;
                    const originalHTML = updateBtn.innerHTML;
                    updateBtn.innerHTML = '<span class="btn-spinner"></span>Updating...';
                    try {
                        const result = await tauriAPI.installHelper();
                        if (result.success) {
                            // Wait for helper to start up
                            await new Promise(resolve => setTimeout(resolve, 2000));
                            await updateHelperStatusIndicator();
                            await checkHelperStatus();
                        } else if (isHelperInstallCancelled(result?.error)) {
                            console.log('Helper update cancelled by user');
                        } else {
                            await message('Failed to update helper: ' + (result.error || 'Unknown error'), { title: 'Error', kind: 'error' });
                        }
                    } catch (e) {
                        console.error('Error updating helper:', e);
                        await message('Error updating helper: ' + e.message, { title: 'Error', kind: 'error' });
                    } finally {
                        updateBtn.disabled = false;
                        updateBtn.innerHTML = originalHTML;
                    }
                });
            }
        }

    } catch (e) {
        statusIndicator.classList.remove('running', 'stopped');
        statusIndicator.classList.add('stopped');
        statusText.textContent = tSettings('helperStatusUnknown');

        if (updateBtn) updateBtn.style.display = 'none';
    }

    // Also update Override All button visibility
    updateOverrideAllButtonVisibility();
}

// Update clean hosts button state (disabled when blocks are running)
export function updateCleanHostsBtnState() {
    const btn = document.getElementById('clean-hosts-btn');
    if (!btn) return;
    const active = hasAnyActiveBlocks();
    btn.disabled = active;
    btn.title = active ? 'Stop all running blocks first' : '';
}

export function getDiagValue(diag, ...keys) {
    for (const key of keys) {
        if (diag && diag[key] !== undefined && diag[key] !== null) {
            return diag[key];
        }
    }
    return undefined;
}

export function getPrettyPrintedDiagnosticsJson(rawText) {
    if (!rawText) return '(unavailable)';
    try {
        return JSON.stringify(JSON.parse(rawText), null, 2);
    } catch (e) {
        return rawText;
    }
}

export function buildDiagnosticsReport(diag) {
    const osName = getDiagValue(diag, 'os_name', 'osName')
        || (navigator.platform?.startsWith('Mac') ? 'macOS' : navigator.platform?.startsWith('Win') ? 'Windows' : 'unknown');
    const arch = getDiagValue(diag, 'arch') || 'unknown';
    const appVersion = document.getElementById('settings-version')?.textContent || '';
    const installed = !!getDiagValue(diag, 'helper_installed', 'helperInstalled');
    const running = !!getDiagValue(diag, 'helper_running', 'helperRunning');
    const version = getDiagValue(diag, 'helper_version', 'helperVersion') || 'Unknown';
    const versionOk = !!getDiagValue(diag, 'helper_version_ok', 'helperVersionOk');
    const expectedVersion = getDiagValue(diag, 'expected_helper_version', 'expectedHelperVersion') || 'unknown';
    const hostsFile = getDiagValue(diag, 'hosts_file', 'hostsFile') || '(unavailable)';
    const hostsPath = getDiagValue(diag, 'hosts_path', 'hostsPath') || '(unknown)';
    const stateFile = getDiagValue(diag, 'helper_state_file', 'helperStateFile') || '(unavailable)';
    const statePath = getDiagValue(diag, 'helper_state_path', 'helperStatePath') || '(unknown)';
    const helperLogTail = getDiagValue(diag, 'helper_log_tail', 'helperLogTail');
    const helperLogPath = getDiagValue(diag, 'helper_log_path', 'helperLogPath');
    const installLogTail = getDiagValue(diag, 'install_log_tail', 'installLogTail');
    const installLogPath = getDiagValue(diag, 'install_log_path', 'installLogPath');
    const helperDisplay = getHelperStatusDisplay({ installed, running, version_ok: versionOk });
    const helperStatusLabel = tSettings(helperDisplay.statusKey);
    const reachable = !!running;

    return {
        osName,
        arch,
        appVersion,
        installed,
        running,
        reachable,
        version,
        versionOk,
        expectedVersion,
        helperStatusLabel,
        helperDisplay,
        hostsFile,
        hostsPath,
        hasReddBlock: hostsFile.includes('BEGIN REDD BLOCK'),
        statePretty: getPrettyPrintedDiagnosticsJson(stateFile),
        statePath,
        helperLogTail,
        helperLogPath,
        installLogTail,
        installLogPath,
    };
}

export function formatDiagnosticsText(diag) {
    const report = buildDiagnosticsReport(diag);
    return [
        '=== System ===',
        `OS: ${report.osName}`,
        `Architecture: ${report.arch}`,
        report.appVersion ? `App version: ${report.appVersion}` : '',
        '',
        '=== Helper Daemon ===',
        `Status: ${report.helperStatusLabel}`,
        `Installed: ${report.installed ? 'Yes' : 'No'}`,
        `Reachable: ${report.reachable ? 'Yes' : 'No'}`,
        `Running: ${report.running ? 'Yes' : 'No'}`,
        `Version OK: ${report.versionOk ? 'Yes' : 'No'}`,
        `Version: ${report.version}`,
        `Expected version: ${report.expectedVersion}`,
        '',
        '=== Paths ===',
        `Hosts file: ${report.hostsPath}`,
        `Helper state file: ${report.statePath}`,
        report.helperLogPath ? `Helper log: ${report.helperLogPath}` : '',
        report.installLogPath ? `Install log: ${report.installLogPath}` : '',
        '',
        '=== Hosts File ===',
        report.hostsFile.trim(),
        '',
        '=== Helper State File ===',
        report.statePretty.trim(),
        report.helperLogTail ? '' : undefined,
        report.helperLogTail ? '=== Helper Log Tail ===' : undefined,
        report.helperLogTail ? report.helperLogTail.trim() : undefined,
        report.installLogTail ? '' : undefined,
        report.installLogTail ? '=== Install Log Tail ===' : undefined,
        report.installLogTail ? report.installLogTail.trim() : undefined,
    ].filter(line => line !== undefined).join('\n');
}

export function captureDiagnosticsScrollState(content) {
    if (!content) return null;
    return {
        contentScrollTop: content.scrollTop,
        preScrollTops: Array.from(content.querySelectorAll('.diagnostics-pre')).map(el => el.scrollTop),
    };
}

export function restoreDiagnosticsScrollState(content, scrollState) {
    if (!content || !scrollState) return;
    content.scrollTop = scrollState.contentScrollTop || 0;
    const preEls = Array.from(content.querySelectorAll('.diagnostics-pre'));
    preEls.forEach((el, idx) => {
        el.scrollTop = scrollState.preScrollTops?.[idx] || 0;
    });
}

export async function refreshDiagnosticsModalContent({ showLoading = false, loadingDelayMs = 0 } = {}) {
    const modal = document.getElementById('diagnostics-modal');
    const content = document.getElementById('diagnostics-content');
    if (!modal || !content) return;

    const scrollState = showLoading ? null : captureDiagnosticsScrollState(content);
    let loadingShown = false;
    let loadingTimer = null;
    let loadingCancelled = false;
    if (showLoading && loadingDelayMs > 0) {
        loadingTimer = setTimeout(() => {
            if (loadingCancelled) return;
            content.innerHTML = '<div class="diagnostics-loading">Loading…</div>';
            loadingShown = true;
        }, loadingDelayMs);
    } else if (showLoading) {
        content.innerHTML = '<div class="diagnostics-loading">Loading…</div>';
        loadingShown = true;
    }

    const stopLoadingTimer = () => {
        loadingCancelled = true;
        if (loadingTimer) {
            clearTimeout(loadingTimer);
            loadingTimer = null;
        }
    };

    let diag = null;
    let enforcementEnabled = false;
    try {
        const diagnosticsTimeoutMs = 20_000;
        diag = await Promise.race([
            invoke('get_system_diagnostics'),
            new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error('Diagnostics timed out — try Refresh')),
                    diagnosticsTimeoutMs,
                );
            }),
        ]);
        try {
            enforcementEnabled = !!(await invoke('get_enforcement_enabled'));
        } catch (_) { /* non-desktop */ }
        stopLoadingTimer();
        content.innerHTML = renderSystemDiagnostics(diag, { enforcementEnabled });
        updateDiagnosticsModalChrome(diag);
        if (!loadingShown) {
            restoreDiagnosticsScrollState(content, scrollState);
        }
    } catch (e) {
        stopLoadingTimer();
        content.innerHTML = `<div class="diagnostics-error">Failed to load diagnostics: ${escapeHtml(e.message || e)}</div>`;
        updateDiagnosticsModalChrome(null);
    }

    const copyBtn = document.getElementById('diagnostics-copy-btn');
    const copyLabel = document.getElementById('diagnostics-copy-btn-label');
    if (copyBtn) {
        copyBtn.onclick = () => {
            if (!diag) {
                if (copyLabel) copyLabel.textContent = tSettings('diagnosticsCopyFailed');
                return;
            }
            const text = JSON.stringify(diag, null, 2);
            navigator.clipboard.writeText(text).then(() => {
                if (copyLabel) copyLabel.textContent = tSettings('diagnosticsCopied');
                setTimeout(() => {
                    if (copyLabel) copyLabel.textContent = tSettings('diagnosticsCopyReport');
                }, 2000);
            }).catch(() => {
                if (copyLabel) copyLabel.textContent = tSettings('diagnosticsCopyFailed');
                setTimeout(() => {
                    if (copyLabel) copyLabel.textContent = tSettings('diagnosticsCopyReport');
                }, 2000);
            });
        };
    }
}

export function updateDiagnosticsModalChrome(diag) {
    const versionEl = document.getElementById('diagnostics-version-label');

    if (versionEl) {
        versionEl.textContent = diag?.app?.version ? `v${diag.app.version}` : '';
    }
}

export function diagnosticsStatusDot(state) {
    if (state === 'ok') return '<span class="diagnostics-status-dot ok" aria-hidden="true">✓</span>';
    if (state === 'off') return '<span class="diagnostics-status-dot off" aria-hidden="true">✗</span>';
    return '<span class="diagnostics-status-dot na" aria-hidden="true"></span>';
}

export function diagnosticsTriState(values) {
    if (!values.length) return 'off';
    if (values.every(v => v === true)) return 'ok';
    if (values.some(v => v === false)) return 'off';
    return 'na';
}

export function diagnosticsBrowserProfiles(key, b) {
    const profiles = b?.profiles || [];
    if (key === 'safari') return profiles;
    const def = profiles.find(p => p.isDefault) || profiles[0];
    return def ? [def] : [];
}

// Extension setup from on-disk profile scan — independent of whether the browser is running.
export function diagnosticsBrowserExtensionState(key, b) {
    const profiles = diagnosticsBrowserProfiles(key, b);
    return {
        installed: diagnosticsTriState(profiles.map(p => p.installed)),
        enabled: diagnosticsTriState(profiles.map(p => p.enabled)),
        privateBrowsing: diagnosticsTriState(profiles.map(p => p.privateBrowsing)),
    };
}

export function diagnosticsAutomationEntry(d, key) {
    const label = BROWSER_STORE_LINKS[key]?.label || key;
    const list = d.automation?.browsers || [];
    const entry = list.find((b) => String(b.label || '').toLowerCase() === key);
    return entry?.state || 'unknown';
}

export function diagnosticsAutomationStatusCell(state) {
    const normalized = String(state || 'unknown').toLowerCase();
    let label;
    if (normalized === 'granted') label = tSettings('diagnosticsAutomationGranted');
    else if (normalized === 'denied') label = tSettings('diagnosticsAutomationDenied');
    else label = tSettings('diagnosticsAutomationUnknown');
    const dotState = normalized === 'granted' ? 'ok' : (normalized === 'denied' ? 'off' : 'na');
    return `<span class="diagnostics-status-cell">${diagnosticsStatusDot(dotState)}<span class="diag-muted">${escapeHtml(label)}</span></span>`;
}

export function diagnosticsKvRow(label, valueHtml) {
    return `<div class="diagnostics-kv-row"><span class="diagnostics-kv-label">${label}</span><span class="diagnostics-kv-value">${valueHtml}</span></div>`;
}

export function diagnosticsKvPreRow(label, lines, escape) {
    const value = lines.length > 0
        ? `<pre class="diagnostics-pre diagnostics-pre-inline">${escape(lines.join('\n'))}</pre>`
        : `<span class="diag-muted">—</span>`;
    return `<div class="diagnostics-kv-row diagnostics-kv-row-multiline"><span class="diagnostics-kv-label">${label}</span><span class="diagnostics-kv-value">${value}</span></div>`;
}

export function diagnosticsYesNoValue(yes) {
    return `<span class="${yes ? 'diag-ok' : ''}">${yes ? tSettings('diagnosticsYes') : tSettings('diagnosticsNo')}</span>`;
}

export function diagnosticsOkNoValue(yes) {
    return `<span class="${yes ? 'diag-ok' : 'diag-error'}">${yes ? tSettings('diagnosticsYes') : tSettings('diagnosticsNo')}</span>`;
}

// Render the structured SystemDiagnostics struct as HTML sections.
// Designed for both user-readable scan AND copy-as-JSON for support.
export function renderSystemDiagnostics(d, { enforcementEnabled = false } = {}) {
    const fmtTs = (ms) => ms ? new Date(ms).toLocaleString() : '—';
    const e = (s) => escapeHtml(String(s));
    let html = '';

    // App (version lives in the modal header)
    html += '<div class="diagnostics-section">';
    html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsAppSection'))}</div>`;
    html += '<div class="diagnostics-card">';
    html += diagnosticsKvRow(e(tSettings('diagnosticsOsArch')), `${e(d.app.os)} / ${e(d.app.arch)}`);
    html += '</div></div>';

    // Currently being blocked
    if (d.current_blocking) {
        const cb = d.current_blocking;
        html += '<div class="diagnostics-section">';
        html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsCurrentlyBlocking'))}</div>`;
        html += '<div class="diagnostics-card">';
        if (cb.blocks && cb.blocks.length > 0) {
            html += '<ul class="diagnostics-list">';
            for (const b of cb.blocks) {
                const label = `${b.emoji ? b.emoji + ' ' : ''}${b.name || b.blocklistId}`;
                const srcLabel = b.source === 'schedule' ? 'schedule' : 'one-off';
                const endsTxt = b.endsAt ? ` until ${new Date(b.endsAt).toLocaleString()}` : '';
                const domainsCount = (b.domains || []).length;
                html += `<li class="diagnostics-kv-row"><span class="diagnostics-kv-label">${e(label)}</span><span class="diagnostics-kv-value diag-muted">${e(srcLabel)}${e(endsTxt)} · ${domainsCount} domain${domainsCount === 1 ? '' : 's'}</span></li>`;
            }
            html += '</ul>';
        } else {
            html += diagnosticsKvRow(
                e(tSettings('diagnosticsActiveSources')),
                `<span class="diag-muted">${e(tSettings('diagnosticsActiveSourcesNone'))}</span>`,
            );
        }
        html += diagnosticsKvPreRow(
            e(tSettings('diagnosticsDomainsCount').replace('{n}', String(cb.domains?.length ?? 0))),
            cb.domains || [],
            e,
        );
        html += diagnosticsKvPreRow(
            e(tSettings('diagnosticsAppsCount').replace('{n}', String(cb.apps?.length ?? 0))),
            cb.apps || [],
            e,
        );
        html += '</div></div>';
    }

    // Migration
    const m = d.migration;
    html += '<div class="diagnostics-section">';
    html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsMigrationSection'))}</div>`;
    html += '<div class="diagnostics-card">';
    html += diagnosticsKvRow(e(tSettings('diagnosticsWasV1x')), diagnosticsYesNoValue(!!m.came_from_v1x));
    if (m.residue_items && m.residue_items.length > 0) {
        html += diagnosticsKvRow(e(tSettings('diagnosticsLeftoverFiles')), `<span class="diag-error">${m.residue_items.length} found</span>`);
        html += '<ul class="diagnostics-list">';
        for (const item of m.residue_items) {
            html += `<li class="diag-error">${e(item)}</li>`;
        }
        html += '</ul>';
    } else {
        html += diagnosticsKvRow(
            e(tSettings('diagnosticsLeftoverFiles')),
            `<span class="diag-ok">${e(tSettings('diagnosticsFullyMigrated'))}</span>`,
        );
    }
    html += diagnosticsKvRow(e(tSettings('diagnosticsStampedVersion')), `<span class="diag-muted">${e(m.ran_at_version || '—')}</span>`);
    html += diagnosticsKvRow(e(tSettings('diagnosticsStampedAt')), `<span class="diag-muted">${e(fmtTs(m.ran_at_ms))}</span>`);
    html += '</div></div>';

    // Full Disk Access (macOS)
    if (d.fda?.applicable) {
        const f = d.fda;
        const choiceLabel = f.onboarding_choice || tSettings('diagnosticsMarkerNotSet');
        html += '<div class="diagnostics-section">';
        html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsFullDiskAccess'))}</div>`;
        html += '<div class="diagnostics-card">';
        html += diagnosticsKvRow(e(tSettings('diagnosticsFdaLiveGranted')), diagnosticsOkNoValue(f.live_granted === true));
        html += diagnosticsKvRow(
            e(tSettings('diagnosticsSafariPlistReadable')),
            f.safari_plist_readable == null
                ? '<span class="diag-muted">—</span>'
                : diagnosticsOkNoValue(f.safari_plist_readable === true),
        );
        html += diagnosticsKvRow(e(tSettings('diagnosticsOnboardingMarker')), `<span class="diag-muted">${e(choiceLabel)}</span>`);
        if (f.safariNeedsFdaAccess != null) {
            const fdaRequired = f.safariNeedsFdaAccess === true;
            html += diagnosticsKvRow(
                e(tSettings('diagnosticsSafariFdaRequired')),
                fdaRequired
                    ? `<span class="diag-error">${e(tSettings('diagnosticsYes'))}</span>`
                    : `<span class="diag-ok">${e(tSettings('diagnosticsNo'))}</span>`,
            );
        }
        html += '</div></div>';
    }

    // Automation (macOS)
    if (d.automation?.applicable) {
        html += '<div class="diagnostics-section">';
        html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsAutomationSection'))}</div>`;
        html += `<p class="diagnostics-section-desc">${e(tSettings('diagnosticsAutomationSectionHint'))}</p>`;
        html += '<div class="diagnostics-card diagnostics-table-wrap"><table class="diagnostics-table diagnostics-table-labeled-status"><thead><tr>';
        html += `<th>${e(tSettings('diagnosticsThBrowser'))}</th>`;
        html += `<th>${e(tSettings('diagnosticsThAutomation'))}</th>`;
        html += '</tr></thead><tbody>';
        for (const key of ['safari', 'chrome', 'brave', 'edge']) {
            const b = d.browsers[key];
            if (!b?.installed) continue;
            if (key !== 'safari' && !browserUsesAutomation(key)) continue;
            const label = BROWSER_STORE_LINKS[key]?.label || key;
            const autoState = diagnosticsAutomationEntry(d, key);
            html += '<tr>';
            html += `<td><div class="diagnostics-browser-cell"><img class="diagnostics-browser-icon" src="${browserIconUrl(key)}" alt="" width="20" height="20">${e(label)}</div></td>`;
            html += `<td>${diagnosticsAutomationStatusCell(autoState)}</td>`;
            html += '</tr>';
        }
        html += '</tbody></table></div></div>';
    }

    // Browsers (extension)
    const extensionBrowserKeys = state.isMacOSDesktop
        ? ['firefox', ...MAC_BLOCKING_METHOD_KEYS.filter((k) => browserBlockingMethod(k) === 'extension')]
        : ['chrome', 'brave', 'edge', 'firefox', 'safari'];
    const browsersHint = state.isMacOSDesktop
        ? tSettings('diagnosticsBrowsersSectionHintMacExtension')
        : tSettings('diagnosticsBrowsersSectionHint');
    html += '<div class="diagnostics-section">';
    html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsBrowsersSection'))}</div>`;
    html += `<p class="diagnostics-section-desc">${e(browsersHint)}</p>`;
    html += '<div class="diagnostics-card diagnostics-table-wrap"><table class="diagnostics-table"><thead><tr>';
    html += `<th>${e(tSettings('diagnosticsThBrowser'))}</th>`;
    html += `<th>${e(tSettings('diagnosticsThExtInstalled'))}</th>`;
    html += `<th>${e(tSettings('diagnosticsThExtEnabled'))}</th>`;
    html += `<th>${e(tSettings('diagnosticsThExtPrivate'))}</th>`;
    html += '</tr></thead><tbody>';
    for (const key of extensionBrowserKeys) {
        const b = d.browsers[key];
        if (!b?.installed) continue;
        const label = BROWSER_STORE_LINKS[key]?.label || key;
        const ext = diagnosticsBrowserExtensionState(key, b);
        html += '<tr>';
        html += `<td><div class="diagnostics-browser-cell"><img class="diagnostics-browser-icon" src="${browserIconUrl(key)}" alt="" width="20" height="20">${e(label)}</div></td>`;
        html += `<td>${diagnosticsStatusDot(ext.installed)}</td>`;
        html += `<td>${diagnosticsStatusDot(ext.enabled)}</td>`;
        html += `<td>${diagnosticsStatusDot(ext.privateBrowsing)}</td>`;
        html += '</tr>';
    }
    html += '</tbody></table></div></div>';

    // Enforcement
    html += '<div class="diagnostics-section">';
    html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsEnforcementSection'))}</div>`;
    html += '<div class="diagnostics-card">';
    if (!state.isIOS && !state.isAndroid) {
        const forceLabel = enforcementEnabled
            ? tSettings('diagnosticsForceCloseEnabled')
            : tSettings('diagnosticsForceCloseDisabled');
        const forceClass = enforcementEnabled ? 'diag-ok' : 'diag-muted';
        html += diagnosticsKvRow(
            e(tSettings('diagnosticsForceClose')),
            `<span class="${forceClass}">${e(forceLabel)}</span>`,
        );
    }
    html += diagnosticsKvRow(e(tSettings('diagnosticsGracePeriod')), `${e(d.enforcer.grace_seconds)} s`);
    if (d.watchdog) {
        html += diagnosticsKvRow(e(tSettings('diagnosticsWatchdog')), diagnosticsYesNoValue(d.watchdog.task_present));
    }
    html += '</div></div>';

    // Recent log
    if (d.recent_log && d.recent_log.length > 0) {
        html += '<div class="diagnostics-section">';
        html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsRecentLogSection').replace('{n}', String(d.recent_log.length)))}</div>`;
        html += '<div class="diagnostics-card">';
        html += `<pre class="diagnostics-pre">${e(d.recent_log.join('\n'))}</pre>`;
        html += '</div></div>';
    }

    // App data (redd-block-data.json)
    if (d.app_data) {
        html += '<div class="diagnostics-section">';
        html += `<div class="diagnostics-section-title">${e(tSettings('diagnosticsAppDataSection'))}</div>`;
        html += '<div class="diagnostics-card">';
        if (d.app_data.path) {
            html += diagnosticsKvRow(e(tSettings('diagnosticsPath')), `<span class="diag-muted">${e(d.app_data.path)}</span>`);
        }
        if (d.app_data.error) {
            html += `<div class="diagnostics-kv-row"><span class="diagnostics-kv-value diag-error">${e(d.app_data.error)}</span></div>`;
        }
        if (d.app_data.pretty_json) {
            html += `<pre class="diagnostics-pre">${e(d.app_data.pretty_json)}</pre>`;
        }
        html += '</div></div>';
    }

    return html;
}

// Diagnostics modal
export function setDiagnosticsButtonLoading(loading) {
    const btn = document.getElementById('diagnostics-btn');
    const label = document.getElementById('settings-diagnostics-btn-label');
    if (!btn || !label) return;

    const icon = btn.querySelector('svg');
    let spinner = btn.querySelector('.diagnostics-btn-spinner');

    if (loading) {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        if (icon) icon.classList.add('hidden');
        if (!spinner) {
            spinner = document.createElement('span');
            spinner.className = 'btn-spinner diagnostics-btn-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            btn.insertBefore(spinner, label);
        } else {
            spinner.classList.remove('hidden');
        }
        label.textContent = tSettings('diagnosticsLoadingBtn');
    } else {
        btn.disabled = false;
        btn.removeAttribute('aria-busy');
        if (icon) icon.classList.remove('hidden');
        if (spinner) spinner.classList.add('hidden');
        label.textContent = tSettings('settingsDiagnosticsBtn');
    }
}

export function closeDiagnosticsModal() {
    const modal = document.getElementById('diagnostics-modal');
    const settingsModal = document.getElementById('settings-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    if (modal.dataset.settingsWasOpen === '1') {
        settingsModal?.classList.remove('hidden');
        startHelperUiRefreshLoop();
    }
    delete modal.dataset.settingsWasOpen;
}

export async function openDiagnosticsModal() {
    const modal = document.getElementById('diagnostics-modal');
    const content = document.getElementById('diagnostics-content');
    const settingsModal = document.getElementById('settings-modal');
    if (!modal || !content) return;
    if (modal.dataset.opening === '1') return;

    modal.dataset.opening = '1';
    const settingsWasOpen = !!(settingsModal && !settingsModal.classList.contains('hidden'));
    modal.dataset.settingsWasOpen = settingsWasOpen ? '1' : '';

    modal.classList.add('hidden');
    setDiagnosticsButtonLoading(true);

    const closeBtn = document.getElementById('close-diagnostics-btn');
    if (closeBtn) {
        closeBtn.onclick = closeDiagnosticsModal;
    }
    modal.onclick = (e) => {
        if (e.target === modal) {
            closeDiagnosticsModal();
        }
    };

    try {
        await refreshDiagnosticsModalContent({ showLoading: false });
        if (settingsWasOpen) {
            settingsModal.classList.add('hidden');
            stopHelperUiRefreshLoop();
        }
        modal.classList.remove('hidden');
    } catch (_) {
        if (settingsWasOpen) {
            settingsModal.classList.add('hidden');
            stopHelperUiRefreshLoop();
        }
        modal.classList.remove('hidden');
    } finally {
        setDiagnosticsButtonLoading(false);
        delete modal.dataset.opening;
    }
}

export async function refreshDiagnosticsModalManual() {
    const btn = document.getElementById('diagnostics-refresh-btn');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
        // Modal is already open — swap to loading only if the fetch is slow
        // enough that stale content would mislead; fast refresh updates in place.
        await refreshDiagnosticsModalContent({ showLoading: true, loadingDelayMs: 400 });
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Setup, onboarding replay, and diagnostics from Settings → Help.
export function setupSettingsHelpButtons() {
    const setupBtn = document.getElementById('settings-setup-btn');
    if (setupBtn && !setupBtn.dataset.wired) {
        setupBtn.dataset.wired = '1';
        setupBtn.addEventListener('click', () => {
            openExtensionSetupOverlay().catch((e) => {
                console.warn('[settings-help] setup overlay failed:', e);
            });
        });
    }

    const onboardingBtn = document.getElementById('settings-onboarding-btn');
    if (onboardingBtn && !onboardingBtn.dataset.wired) {
        onboardingBtn.dataset.wired = '1';
        onboardingBtn.addEventListener('click', () => {
            restartOnboardingFromSettings().catch((e) => {
                console.warn('[settings-help] onboarding replay failed:', e);
            });
        });
    }

    const diagnosticsBtn = document.getElementById('diagnostics-btn');
    if (diagnosticsBtn && !diagnosticsBtn.dataset.wired) {
        diagnosticsBtn.dataset.wired = '1';
        diagnosticsBtn.addEventListener('click', openDiagnosticsModal);
    }

    const diagnosticsRefreshBtn = document.getElementById('diagnostics-refresh-btn');
    if (diagnosticsRefreshBtn && !diagnosticsRefreshBtn.dataset.wired) {
        diagnosticsRefreshBtn.dataset.wired = '1';
        diagnosticsRefreshBtn.addEventListener('click', () => {
            void refreshDiagnosticsModalManual();
        });
    }
}

// Any blocks or schedules the user could clear via Stop All — includes
// future scheduled segments, not only what is enforcing right now.
export function hasAnyActiveBlocks() {
    return hasAnyBlockingStateToClear();
}

// Manage section: macOS and Windows always show Uninstall guidance; Stop All when relevant.
export function updateManageSectionVisibility() {
    const section = document.getElementById('settings-manage-section');
    if (!section) return;
    const isMac = document.body.classList.contains('mac');
    const isWindows = document.body.classList.contains('windows');
    const showOverride = hasAnyBlockingStateToClear();
    section.classList.toggle('hidden', !isMac && !isWindows && !showOverride);
}

// Show Stop All while there are active blocks or schedules to clear.
export function updateOverrideAllButtonVisibility() {
    const row = document.getElementById('settings-override-all-row');
    const showOverride = hasAnyBlockingStateToClear();

    if (row) row.classList.toggle('hidden', !showOverride);
    updateManageSectionVisibility();
    updateGraceSettingLock();
    // Cheap, and catches app-data changes that bypass the language pass
    // (importing a backup rewrites settings.defaultPauseMinutes).
    syncDefaultPauseSettingUi();
}

// Show challenge for removing helper when blocks are active


// Setup the configurable browser-extension grace period.
// Backend reads `settings.extensionGraceSeconds` from the data file
// on every grace-start (no app restart needed). Backend rejects
// increases when at least one block is currently active.
// ---- Installed Apps Picker Modal ------------------------------------------
// Shows a searchable list of installed apps (scanned from Start Menu on
// Windows, /Applications on macOS) so users don't have to navigate the
// OS file picker to find executables.


// Setup the configurable browser-extension grace period.
export function setupGraceSetting() {
    const input = document.getElementById('grace-seconds-input');
    const errorEl = document.getElementById('grace-error');
    if (!input) return;

    const showError = (msg) => {
        if (!errorEl) return;
        errorEl.textContent = msg;
        errorEl.classList.toggle('hidden', !msg);
    };

    // Load current value and reflect locked state.
    const refresh = async () => {
        try {
            const secs = await invoke('get_extension_grace_seconds');
            input.value = secs;
            updateGraceSettingLock();
        } catch (e) {
            console.warn('[grace] read failed:', e);
        }
    };
    refresh();

    let lastGood = parseInt(input.value, 10) || 60;
    input.addEventListener('change', async () => {
        const now = Date.now();
        const nowDate = new Date(now);
        if (hasAnyEnforcedBlocks(now, nowDate)) {
            input.value = lastGood;
            updateGraceSettingLock();
            return;
        }

        const raw = parseInt(input.value, 10);
        if (!Number.isFinite(raw)) {
            input.value = lastGood;
            return;
        }
        const clamped = Math.max(5, Math.min(300, raw));
        input.value = clamped;
        try {
            const applied = await invoke('set_extension_grace_seconds', { seconds: clamped });
            input.value = applied;
            lastGood = applied;
            showError('');
        } catch (e) {
            const msg = typeof e === 'string' ? e : (e && e.message) || 'Could not update grace period.';
            showError(msg);
            input.value = lastGood;
        }
    });
}

// Setup Override All functionality in settings
export function setupOverrideAll() {
    const overrideAllModal = document.getElementById('override-all-modal');
    const cancelOverrideAllBtn = document.getElementById('cancel-override-all-btn');
    const confirmOverrideAllBtn = document.getElementById('confirm-override-all-btn');
    const overrideAllBtn = document.getElementById('override-all-btn');
    const challenge = getChallengeController('overrideAll');

    // Open override all modal
    if (overrideAllBtn && overrideAllModal) {
        overrideAllBtn.addEventListener('click', () => {
            // Close settings modal first
            document.getElementById('settings-modal').classList.add('hidden');
            setLanguagePickerOpen(false);

            // Nothing is being enforced, so there is nothing to type your way
            // out of. skipChallenge also clears both inputs — this path used to
            // leave stale text in a now-hidden textarea, which then failed the
            // comparison against '' with no way for the user to reach the field.
            const nothingToClear = !hasAnyBlockingStateToClear();
            const instructionEl = document.getElementById('override-all-instruction');
            if (instructionEl) instructionEl.classList.toggle('hidden', nothingToClear);
            overrideAllModal.querySelector('.challenge-progress')?.classList.toggle('hidden', nothingToClear);

            challenge.open({
                difficulty: nothingToClear ? null : findHardestChallenge(),
                skipChallenge: nothingToClear,
            });

            overrideAllModal.classList.remove('hidden');
            requestAnimationFrame(() => challenge.focus());
        });
    }

    if (cancelOverrideAllBtn) {
        cancelOverrideAllBtn.addEventListener('click', closeOverrideAllModal);
    }

    // Click outside to close
    if (overrideAllModal) {
        overrideAllModal.addEventListener('click', (e) => {
            if (e.target === overrideAllModal) closeOverrideAllModal();
        });
    }

    // Confirm override all
    if (confirmOverrideAllBtn) {
        confirmOverrideAllBtn.addEventListener('click', async () => {
            // 'advanced' = a correct but non-final word; the user keeps typing.
            if (challenge.handleConfirm().status !== 'ok') return;
            await performOverrideAll();
            closeOverrideAllModal();
        });
    }
}

/**
 * Close the stop-all dialog and hand the user back to settings, where they came
 * from. Previously inlined at three call sites which had drifted — the success
 * path forgot to restore the settings modal — and absent from
 * ANDROID_MODAL_CLOSE_FNS entirely, so Android back left it half-reset.
 */
export function closeOverrideAllModal() {
    document.getElementById('override-all-modal')?.classList.add('hidden');
    getChallengeController('overrideAll').reset();
    document.getElementById('settings-modal')?.classList.remove('hidden');
}

// macOS in-app uninstall. The Uninstall button lives in Settings below
// Advanced options (not inside the collapsible). Hidden on Windows
// (`.macos-only` + `body.mac` gate) because Windows uses
// Settings → Apps → Uninstall, fully wired up by NSIS_HOOK_PREUNINSTALL.
//
// The button is *disabled* (not hidden) when any block / schedule is
// currently active, with a hint paragraph below nudging the user
// toward the Override-All challenge above. Rationale: uninstalling
// mid-block would leave the user with an unenforceable promise
// (no app = no enforcer), so we want the user to deliberately stop
// blocking first via the existing override path.

export function firefoxHasReddFocusExtension(firefox) {
    const profiles = firefox?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) return false;
    return profiles.some((p) => p.installed);
}

export function applyUninstallConfirmModalStaticCopy() {
    syncUninstallDeleteDataCopy();

    const finderText = document.getElementById('uninstall-finder-warning-text');
    if (finderText) finderText.innerHTML = tSettings('uninstallFinderWarningHtml');

    const logo = document.getElementById('uninstall-firefox-callout-logo');
    if (logo) {
        logo.src = logoReddFocusUrl;
        logo.alt = '';
    }

    const titleText = document.getElementById('uninstall-firefox-callout-title-text');
    if (titleText) titleText.textContent = tSettings('uninstallFirefoxCalloutTitle');

    const badge = document.getElementById('uninstall-firefox-callout-badge');
    if (badge) badge.textContent = tSettings('uninstallExtFirefoxBadge');

    const detail = document.getElementById('uninstall-firefox-callout-detail');
    if (detail) {
        detail.innerHTML = tSettings('uninstallFirefoxCalloutDetailHtml')
            .replace('{URL_CHIP}', extensionsUrlChipHtml('firefox'));
        attachCopyChipHandlers(detail);
    }
}

export function syncUninstallConfirmModal(browsers) {
    applyUninstallConfirmModalStaticCopy();
    const callout = document.getElementById('uninstall-firefox-callout');
    if (!callout) return;
    const showFirefox = !!(browsers && firefoxHasReddFocusExtension(browsers.firefox));
    callout.classList.toggle('hidden', !showFirefox);
}

export async function fetchInstalledBrowsersForUninstall() {
    try {
        return await invoke('scan_browser_profiles');
    } catch (e) {
        if (lastOnboardingState?.browsers) {
            console.warn('uninstall: scan_browser_profiles failed, using cached browser state', e);
            return lastOnboardingState.browsers;
        }
        throw e;
    }
}

let uninstallConfirmResolver = null;

export function syncUninstallDeleteDataCopy() {
    const checkbox = document.getElementById('uninstall-delete-data-checkbox');
    const lead = document.getElementById('uninstall-confirm-lead');
    if (!lead) return;
    const deleteData = checkbox?.checked === true;
    lead.innerHTML = tSettings(deleteData ? 'uninstallConfirmLeadDeleteHtml' : 'uninstallConfirmLeadHtml');
}

export async function showUninstallConfirmModal() {
    const modal = document.getElementById('uninstall-confirm-modal');
    if (!modal) return null;

    const checkbox = document.getElementById('uninstall-delete-data-checkbox');
    if (checkbox) checkbox.checked = false;
    syncUninstallDeleteDataCopy();

    try {
        const browsers = await fetchInstalledBrowsersForUninstall();
        syncUninstallConfirmModal(browsers);
    } catch (e) {
        console.warn('uninstall: browser scan failed — hiding Firefox callout', e);
        syncUninstallConfirmModal(null);
    }

    return new Promise((resolve) => {
        uninstallConfirmResolver = resolve;
        modal.classList.remove('hidden');
    });
}

export function closeUninstallConfirmModal(result) {
    const modal = document.getElementById('uninstall-confirm-modal');
    const checkbox = document.getElementById('uninstall-delete-data-checkbox');
    modal?.classList.add('hidden');
    if (uninstallConfirmResolver) {
        uninstallConfirmResolver(
            result ? { deleteUserData: checkbox?.checked === true } : null
        );
        uninstallConfirmResolver = null;
    }
}

export function setupInAppUninstall() {
    const btn = document.getElementById('uninstall-app-btn');
    if (!btn) return;

    const modal = document.getElementById('uninstall-confirm-modal');
    document.getElementById('cancel-uninstall-confirm-btn')
        ?.addEventListener('click', () => closeUninstallConfirmModal(false));
    document.getElementById('confirm-uninstall-confirm-btn')
        ?.addEventListener('click', () => closeUninstallConfirmModal(true));
    document.getElementById('uninstall-delete-data-checkbox')
        ?.addEventListener('change', syncUninstallDeleteDataCopy);
    modal?.addEventListener('click', (e) => {
        if (e.target === modal) closeUninstallConfirmModal(false);
    });

    refreshUninstallButtonState();
    updateOverrideAllButtonVisibility();

    btn.addEventListener('click', async () => {
        // Re-check at click time so a schedule that fired between
        // settings-open and click can still gate us out cleanly.
        if (hasAnyBlockingStateToClear()) {
            refreshUninstallButtonState();
            return;
        }

        let confirmResult;
        try {
            confirmResult = await showUninstallConfirmModal();
        } catch (e) {
            console.error('uninstall: confirm dialog failed', e);
            return;
        }
        if (!confirmResult) return;

        // Close settings so the user sees a clean window before the
        // process exits and the bundle disappears.
        document.getElementById('settings-modal')?.classList.add('hidden');
        setLanguagePickerOpen(false);

        try {
            await tauriAPI.uninstallSelfMacos(confirmResult.deleteUserData);
            // Backend exits ~200ms later. The window typically
            // disappears before this promise resolves; nothing else
            // to do on success.
        } catch (e) {
            console.error('uninstall: backend command failed', e);
            try {
                await message(`${tSettings('uninstallFailed')}\n\n${e}`, {
                    title: tSettings('uninstallFailedTitle'),
                    kind: 'error',
                });
            } catch (_) { /* swallow — best-effort error surface */ }
        }
    });
}

// Refresh Uninstall / Open Settings buttons when blocks are active (same gate as macOS).
export function refreshUninstallButtonState() {
    const blocking = hasAnyBlockingStateToClear();
    const disabledHint = tSettings('uninstallDisabledHint');

    for (const { btnId, hintId } of [
        { btnId: 'uninstall-app-btn', hintId: 'uninstall-app-hint' },
        { btnId: 'windows-uninstall-open-settings-btn', hintId: 'windows-uninstall-app-hint' },
    ]) {
        const btn = document.getElementById(btnId);
        const hint = document.getElementById(hintId);
        if (!btn) continue;

        if (blocking) {
            btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
            if (hint) {
                hint.textContent = disabledHint;
                hint.classList.remove('hidden');
            }
        } else {
            btn.disabled = false;
            btn.removeAttribute('aria-disabled');
            if (hint) {
                hint.textContent = '';
                hint.classList.add('hidden');
            }
        }
    }
}

export function setupWindowsUninstallGuidance() {
    if (state.isIOS || state.isAndroid) return;
    const btn = document.getElementById('windows-uninstall-open-settings-btn');
    if (!btn) return;

    refreshUninstallButtonState();

    btn.addEventListener('click', async () => {
        if (hasAnyBlockingStateToClear()) {
            refreshUninstallButtonState();
            return;
        }

        try {
            await openUrl(WINDOWS_APPS_SETTINGS_URI);
        } catch (e) {
            console.error('windows uninstall: open Settings failed', e);
            try {
                await message(`${tSettings('windowsUninstallOpenFailed')}\n\n${e}`, {
                    title: tSettings('windowsUninstallOpenFailedTitle'),
                    kind: 'error',
                });
            } catch (_) { /* dialog dismissed */ }
        }
    });
}


// Find the hardest challenge among all block/schedule state that could still resume later.
export function findHardestChallenge() {
    const now = Date.now();
    const nowDate = new Date(now);
    let hardestDifficulty = null;

    // Check one-off blocks that still have remaining time.
    for (const block of state.appData.activeBlocks) {
        if (isOneOffBlockStillActive(block, now)) {
            const blocklist = state.appData.blocklists.find(bl => bl.id === block.blocklistId);
            if (blocklist?.overrideDifficulty) {
                hardestDifficulty = hardestDifficulty
                    ? compareDifficulties(hardestDifficulty, blocklist.overrideDifficulty)
                    : blocklist.overrideDifficulty;
            }
        }
    }

    // Check schedules that can still become active later.
    for (const schedule of state.appData.schedules || []) {
        if (!schedule.segments) continue;
        if (!scheduleCanStillBecomeActive(schedule, nowDate)) continue;

        const blocklist = state.appData.blocklists.find(bl => bl.id === schedule.blocklistId);
        if (blocklist?.overrideDifficulty) {
            hardestDifficulty = hardestDifficulty
                ? compareDifficulties(hardestDifficulty, blocklist.overrideDifficulty)
                : blocklist.overrideDifficulty;
        }
    }

    if (!hardestDifficulty) return { type: 'random-words', count: 50 };

    // Resolve effective count for maxDifficulty (handles single-block case
    // where compareDifficulties was never called)
    if (hardestDifficulty.maxDifficulty === true && hardestDifficulty.count === undefined) {
        const effectiveCount = getMaxOverrideCharsForType(hardestDifficulty.type);
        return { ...hardestDifficulty, count: effectiveCount };
    }
    return hardestDifficulty;
}

// Compare two difficulties and return the harder one
export function compareDifficulties(a, b) {
    if (!a) return b;
    if (!b) return a;

    const getTypeRank = (difficulty) => {
        if (difficulty.type === 'custom') return 3;
        if (difficulty.type === 'gibberish') return 2;
        if (difficulty.type === 'random-words') return 1;
        return 0;
    };

    const aCount = getDifficultyTypingCharCount(a);
    const bCount = getDifficultyTypingCharCount(b);

    let winner;
    if (bCount > aCount) winner = b;
    else if (aCount > bCount) winner = a;
    else {
        // Same character count: custom > gibberish > random-words
        const aRank = getTypeRank(a);
        const bRank = getTypeRank(b);
        if (bRank > aRank) winner = b;
        else if (aRank > bRank) winner = a;
        else winner = a; // Equal, return a
    }

    // Resolve stored count for generation when maxDifficulty (keep word counts on iOS)
    if (winner.maxDifficulty === true) {
        const genCount = getMaxOverrideCharsForType(winner.type);
        if (winner.count !== genCount) {
            return { ...winner, count: genCount };
        }
    }
    return winner;
}

// Perform the actual override-all operation
export async function performOverrideAll() {
    try {
        const androidManualBlockIds = state.isAndroid
            ? state.appData.activeBlocks.map((block) => block.id).filter(Boolean)
            : [];

        // Clear all active blocks
        state.appData.activeBlocks = [];

        // Clear all schedules
        state.appData.schedules = [];

        // Save the data
        await saveData();

        // Full cleanup on the helper side
        if (state.isIOS) {
            await tauriAPI.screentimeClearBlock();
        } else if (state.isAndroid) {
            for (const id of androidManualBlockIds) {
                try {
                    await tauriAPI.androidStopManualBlock(id);
                } catch (e) {
                    console.warn('Failed to clear Android manual block:', e);
                }
            }
            try {
                await tauriAPI.androidSetSchedules([]);
            } catch (e) {
                console.warn('Failed to clear Android schedules:', e);
            }
        } else {
            const status = await refreshDesktopHelperStatus();
            if (status.helperReady) {
                // Atomically set everything to empty — helper will know nothing should be blocked
                try { await tauriAPI.setBlocksViaHelper([]); } catch (e) { console.warn('Failed to clear blocks:', e); }
                try { await tauriAPI.setSchedulesViaHelper([]); } catch (e) { console.warn('Failed to clear schedules:', e); }
                try { await tauriAPI.setBlockedAppsViaHelper([]); } catch (e) { console.warn('Failed to clear apps:', e); }
            }
            // Always clean the hosts file as a safety net, even if the helper is stopped or stale.
            try { await tauriAPI.cleanHostsFile(); } catch (e) { console.warn('Failed to clean hosts file:', e); }
        }

        // Update blocked apps (will stop watcher if no apps to block)
        await updateBlockedApps();

        // Re-render the UI
        render();

        // Reset the blocklist selection UI
        const blocklistSelect = document.getElementById('blocklist-select');
        if (blocklistSelect) {
            handleBlocklistSelect({ target: blocklistSelect });
        }

        console.log('Override-all completed — all blocks, schedules, apps, and hosts entries cleared');
    } catch (err) {
        console.error('Error during override all:', err);
    }
}
