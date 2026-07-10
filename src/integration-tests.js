/**
 * ReddBlock Tier 2 Integration Tests
 *
 * These tests run through the app -> Tauri -> helper pipeline
 * and can modify real system state.
 *
 * Profiles:
 * - runIntegrationTests('core')  // fast critical checks (default)
 * - runIntegrationTests('full')  // core + exhaustive non-UI checks
 */

(function () {
    'use strict';

    const PROFILE_CORE = 'core';
    const PROFILE_FULL = 'full';
    const TEST_PREFIX = 'inttest';
    let testIdCounter = 0;

    // Access app internals (exposed by app.js for testing)
    const getInternals = () => window.__REDDBLOCK_INTERNALS__;
    const getAppData = () => getInternals()?.appData;
    const callSaveData = () => getInternals()?.saveData?.();
    const callUpdateHostsFile = (silent) => getInternals()?.updateHostsFile?.(silent);
    const getTauriAPI = () => getInternals()?.tauriAPI;
    const callRender = () => getInternals()?.render?.();

    const TEST_DOMAINS = {
        a: 'integration-a-reddblock.invalid',
        b: 'integration-b-reddblock.invalid',
        shared: 'integration-shared-reddblock.invalid',
        future: 'integration-future-reddblock.invalid'
    };

    function nowMs() {
        return Date.now();
    }

    function makeId(suffix) {
        testIdCounter += 1;
        return `${TEST_PREFIX}-${suffix}-${nowMs()}-${testIdCounter}`;
    }

    function currentDayMon0() {
        const d = new Date().getDay();
        return d === 0 ? 6 : d - 1;
    }

    function shortWait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function assertOrThrow(condition, message) {
        if (!condition) throw new Error(message);
    }

    // v3 enforcement read-back: `get_system_diagnostics` → `current_blocking`
    // is the Rust-derived snapshot of what the extension / Automation watcher
    // enforce (flat blocked `domains`, per-block `blocks[]` with mode, and the
    // allowlist unions). It re-derives from redd-block-data.json at call time,
    // so an awaited saveData is enough — no watcher latency to wait out.
    async function getCurrentBlockingOrThrow(testName) {
        const tauriAPI = getTauriAPI();
        assertOrThrow(tauriAPI && typeof tauriAPI.getSystemDiagnostics === 'function', `${testName}: getSystemDiagnostics unavailable`);
        const diag = await tauriAPI.getSystemDiagnostics();
        const cb = diag?.current_blocking;
        assertOrThrow(cb, `${testName}: current_blocking missing from system diagnostics`);
        return cb;
    }

    async function assertEnforcedDomain(testName, domain) {
        const cb = await getCurrentBlockingOrThrow(testName);
        assertOrThrow(cb.domains.includes(domain), `${testName}: ${domain} missing from current_blocking.domains`);
    }

    async function assertNotEnforcedDomain(testName, domain) {
        const cb = await getCurrentBlockingOrThrow(testName);
        assertOrThrow(!cb.domains.includes(domain), `${testName}: ${domain} still in current_blocking.domains`);
    }

    async function ensureHelperRunningOrSkip(testName) {
        const tauriAPI = getTauriAPI();
        if (!tauriAPI) {
            return { skipped: true, reason: `${testName}: tauriAPI unavailable` };
        }
        const status = await tauriAPI.checkHelperStatus();
        if (!status.running) {
            return { skipped: true, reason: `${testName}: helper not running` };
        }
        if (!status.version_ok) {
            return { skipped: true, reason: `${testName}: helper version mismatch` };
        }
        return null;
    }

    function addTestBlocklist({ websites = [], apps = [], name = 'Integration Test', mode = 'manual' } = {}) {
        const appData = getAppData();
        const blocklist = {
            id: makeId('bl'),
            name: `${name} ${Math.floor(Math.random() * 1000)}`,
            mode,
            websites,
            apps,
            emoji: '🧪',
            color: '#ff0000',
            overrideDifficulty: { type: 'random-words', count: 10 }
        };
        appData.blocklists.push(blocklist);
        return blocklist;
    }

    function addActiveBlock(blocklistId, { durationMs = 120000, startOffsetMs = 0, endOffsetMs = null, isPaused = false, pauseMs = 60000 } = {}) {
        const appData = getAppData();
        const now = nowMs();
        const startTime = now + startOffsetMs;
        const endTime = endOffsetMs != null ? now + endOffsetMs : startTime + durationMs;
        const block = {
            id: makeId('block'),
            blocklistId,
            startTime,
            endTime
        };
        if (isPaused) {
            block.isPaused = true;
            block.pauseEndTime = now + pauseMs;
        }
        appData.activeBlocks.push(block);
        return block;
    }

    function addSchedule(blocklistId, segments, { repeatType = 'no' } = {}) {
        const appData = getAppData();
        appData.schedules = appData.schedules || [];
        const sched = {
            id: makeId('sched'),
            blocklistId,
            segments,
            repeatType,
            createdAt: nowMs()
        };
        appData.schedules.push(sched);
        return sched;
    }

    function removeTestDataFromAppState() {
        const appData = getAppData();
        if (!appData) return;
        appData.activeBlocks = (appData.activeBlocks || []).filter(b => !String(b.id || '').startsWith(TEST_PREFIX));
        appData.schedules = (appData.schedules || []).filter(s => !String(s.id || '').startsWith(TEST_PREFIX));
        appData.blocklists = (appData.blocklists || []).filter(bl => !String(bl.id || '').startsWith(TEST_PREFIX));
    }

    let originalAppDataBackup = null;

    async function setupSuite() {
        console.log('🔧 Setting up Tier 2 integration suite...');
        const appData = getAppData();
        assertOrThrow(appData, 'App internals not available. Ensure app.js loaded.');
        
        // Take a complete snapshot of the user's state to ensure we restore it exactly
        originalAppDataBackup = JSON.parse(JSON.stringify(appData));
        await callSaveData();
        return true;
    }

    async function teardownSuite() {
        console.log('🧹 Cleaning up Tier 2 integration suite...');
        try {
            const tauriAPI = getTauriAPI();
            
            // Restore structural state from snapshot
            if (originalAppDataBackup) {
                const appData = getAppData();
                if (appData) {
                    Object.keys(appData).forEach(k => delete appData[k]);
                    Object.assign(appData, JSON.parse(JSON.stringify(originalAppDataBackup)));
                }
            } else {
                removeTestDataFromAppState();
            }
            
            await callSaveData();

            // Sync the precisely restored state to the daemon (handles both hosts and apps)
            if (tauriAPI) {
                const status = await tauriAPI.checkHelperStatus();
                if (status.running && status.version_ok) {
                    await callUpdateHostsFile(false);
                }
            }
            
            callRender();
            console.log('   ✅ Cleanup complete');
            return true;
        } catch (err) {
            console.error('   ❌ Cleanup failed:', err);
            return false;
        }
    }

    async function resetIntegrationTestState(testName) {
        removeTestDataFromAppState();
        await callSaveData();

        const tauriAPI = getTauriAPI();
        if (!tauriAPI) return;

        const status = await tauriAPI.checkHelperStatus();
        if (status.running && status.version_ok) {
            const result = await callUpdateHostsFile(false);
            assertOrThrow(result && result.success, `${testName}: reset sync failed`);
        }
    }

    async function runIsolatedIntegrationTest(testName, fn) {
        await resetIntegrationTestState(`${testName} setup`);
        let testError = null;
        let result;

        try {
            result = await fn();
        } catch (err) {
            testError = err;
        }

        try {
            await resetIntegrationTestState(`${testName} cleanup`);
        } catch (cleanupErr) {
            if (!testError) throw cleanupErr;
            console.warn(`${testName}: cleanup after failure also failed`, cleanupErr);
        }

        if (testError) throw testError;
        return result;
    }

    async function runCase(name, fn) {
        try {
            const result = await fn();
            if (result?.skipped) return { status: 'skipped', error: result.reason };
            if (result?.passed) return { status: 'passed' };
            return { status: 'failed', error: result?.error || 'Unknown failure' };
        } catch (err) {
            return { status: 'failed', error: err?.message || String(err) };
        }
    }

    async function setOneOffPaused(blockId, pauseMs) {
        const appData = getAppData();
        const block = appData.activeBlocks.find(b => b.id === blockId);
        assertOrThrow(block, `pause helper: block not found (${blockId})`);
        block.isPaused = true;
        block.pauseEndTime = nowMs() + pauseMs;
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'pause helper: one-off pause sync failed');
        return block;
    }

    async function clearOneOffPause(blockId) {
        const appData = getAppData();
        const block = appData.activeBlocks.find(b => b.id === blockId);
        assertOrThrow(block, `resume helper: block not found (${blockId})`);
        delete block.isPaused;
        delete block.pauseEndTime;
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'resume helper: one-off resume sync failed');
        return block;
    }

    async function setSchedulePaused(blocklistId, pauseMs) {
        const appData = getAppData();
        const schedule = (appData.schedules || []).find(s => s.blocklistId === blocklistId);
        assertOrThrow(schedule, `pause helper: schedule not found (${blocklistId})`);
        schedule.isPaused = true;
        schedule.pauseEndTime = nowMs() + pauseMs;
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'pause helper: schedule pause sync failed');
        return schedule;
    }

    async function clearSchedulePause(blocklistId) {
        const appData = getAppData();
        const schedule = (appData.schedules || []).find(s => s.blocklistId === blocklistId);
        assertOrThrow(schedule, `resume helper: schedule not found (${blocklistId})`);
        delete schedule.isPaused;
        delete schedule.pauseEndTime;
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'resume helper: schedule resume sync failed');
        return schedule;
    }

    // ========================================
    // Testing Group A: One-off and schedule mechanics
    // ========================================

    async function testA1_enforcementDerivationPath() {
        const skip = await ensureHelperRunningOrSkip('A1');
        if (skip) return skip;

        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'A1' });
        addActiveBlock(bl.id, { durationMs: 120000 });
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'A1: updateHostsFile failed');
        await assertEnforcedDomain('A1', TEST_DOMAINS.a);

        removeTestDataFromAppState();
        await callSaveData();
        const cleanupResult = await callUpdateHostsFile(true);
        assertOrThrow(cleanupResult && cleanupResult.success, 'A1: cleanup updateHostsFile failed');
        assertOrThrow(!cleanupResult.deferred, 'A1: cleanup was deferred instead of syncing helper state');
        await assertNotEnforcedDomain('A1', TEST_DOMAINS.a);
        return { passed: true };
    }

    async function testA2_blockStartEndTiming() {
        const skip = await ensureHelperRunningOrSkip('A2');
        if (skip) return skip;

        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.b], name: 'A2' });
        const block = addActiveBlock(bl.id, { durationMs: 5000 });
        await callSaveData();
        await callUpdateHostsFile();

        await new Promise(resolve => setTimeout(resolve, 6200));
        const appData = getAppData();
        const stillActive = appData.activeBlocks.some(b => b.id === block.id && b.endTime > nowMs());
        assertOrThrow(!stillActive, 'A2: one-off block did not expire naturally');
        await callUpdateHostsFile(true);
        return { passed: true };
    }

    async function testA3_scheduleActiveNow() {
        const skip = await ensureHelperRunningOrSkip('A3');
        if (skip) return skip;

        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.shared], name: 'A3' });
        const hour = new Date().getHours();
        addSchedule(bl.id, [{
            startHour: hour,
            startMinute: 0,
            endHour: (hour + 1) % 24,
            endMinute: 0,
            days: [currentDayMon0()]
        }]);

        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'A3: schedule activation path failed');
        await assertEnforcedDomain('A3', TEST_DOMAINS.shared);
        return { passed: true };
    }

    async function testA4_futureScheduleDoesNotThrow() {
        const skip = await ensureHelperRunningOrSkip('A4');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A4', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.future], name: 'A4' });
            const hour = new Date().getHours();
            addSchedule(bl.id, [{
                startHour: (hour + 1) % 24,
                startMinute: 0,
                endHour: (hour + 2) % 24,
                endMinute: 0,
                days: [currentDayMon0()]
            }]);

            await callSaveData();
            const result = await callUpdateHostsFile();
            assertOrThrow(result && result.success, 'A4: future schedule update failed');
            await assertNotEnforcedDomain('A4', TEST_DOMAINS.future);
            return { passed: true };
        });
    }

    async function testA5_pauseResumeOneOffStatePath() {
        const skip = await ensureHelperRunningOrSkip('A5');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A5', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'A5' });
            const block = addActiveBlock(bl.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();

            block.isPaused = true;
            block.pauseEndTime = nowMs() + 60000;
            await callSaveData();
            const pausedResult = await callUpdateHostsFile();
            assertOrThrow(pausedResult && pausedResult.success, 'A5: paused state update failed');
            await assertNotEnforcedDomain('A5', TEST_DOMAINS.a);

            delete block.isPaused;
            delete block.pauseEndTime;
            await callSaveData();
            const resumedResult = await callUpdateHostsFile();
            assertOrThrow(resumedResult && resumedResult.success, 'A5: resume state update failed');
            await assertEnforcedDomain('A5', TEST_DOMAINS.a);
            return { passed: true };
        });
    }

    async function testA6_pauseResumeOneOffEnforcementPath() {
        const skip = await ensureHelperRunningOrSkip('A6');
        if (skip) return skip;

        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], apps: ['Calculator'], name: 'A6' });
        const block = addActiveBlock(bl.id, { durationMs: 120000 });
        await callSaveData();
        await callUpdateHostsFile();
        await assertEnforcedDomain('A6', TEST_DOMAINS.a);

        await setOneOffPaused(block.id, 45000);
        assertOrThrow(!!block.isPaused, 'A6: block should be paused');
        assertOrThrow(block.pauseEndTime > nowMs(), 'A6: pause end time should be future');
        await assertNotEnforcedDomain('A6', TEST_DOMAINS.a);

        await clearOneOffPause(block.id);
        assertOrThrow(!block.isPaused, 'A6: block should be resumed');
        assertOrThrow(!block.pauseEndTime, 'A6: pause end time should be cleared');
        await assertEnforcedDomain('A6', TEST_DOMAINS.a);
        return { passed: true };
    }

    async function testA7_pauseNaturalExpiryOneOffSmoke() {
        const skip = await ensureHelperRunningOrSkip('A7');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A7', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.b], name: 'A7' });
            const block = addActiveBlock(bl.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();

            await setOneOffPaused(block.id, 1200);
            await shortWait(2500);
            const appData = getAppData();
            const refreshed = appData.activeBlocks.find(b => b.id === block.id);
            assertOrThrow(refreshed, 'A7: block missing after pause expiry wait');
            assertOrThrow(!refreshed.isPaused, 'A7: one-off pause should naturally expire');
            assertOrThrow(!refreshed.pauseEndTime, 'A7: one-off pauseEndTime should be cleared after natural expiry');
            const result = await callUpdateHostsFile();
            assertOrThrow(result && result.success, 'A7: post-expiry update failed');
            await assertEnforcedDomain('A7', TEST_DOMAINS.b);
            return { passed: true };
        });
    }

    async function testA8_pauseResumeScheduleActivePath() {
        const skip = await ensureHelperRunningOrSkip('A8');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A8', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.shared], apps: ['Calculator'], name: 'A8' });
            const hour = new Date().getHours();
            addSchedule(bl.id, [{
                startHour: hour,
                startMinute: 0,
                endHour: (hour + 1) % 24,
                endMinute: 0,
                days: [currentDayMon0()]
            }]);
            await callSaveData();
            await callUpdateHostsFile();
            await assertEnforcedDomain('A8', TEST_DOMAINS.shared);

            const pausedSchedule = await setSchedulePaused(bl.id, 45000);
            assertOrThrow(!!pausedSchedule.isPaused, 'A8: schedule should be paused');
            assertOrThrow(pausedSchedule.pauseEndTime > nowMs(), 'A8: schedule pause end should be future');
            await assertNotEnforcedDomain('A8', TEST_DOMAINS.shared);

            const resumedSchedule = await clearSchedulePause(bl.id);
            assertOrThrow(!resumedSchedule.isPaused, 'A8: schedule should be resumed');
            assertOrThrow(!resumedSchedule.pauseEndTime, 'A8: schedule pauseEndTime should be cleared');
            await assertEnforcedDomain('A8', TEST_DOMAINS.shared);
            return { passed: true };
        });
    }

    async function testA9_pauseNaturalExpiryScheduleSmoke() {
        const skip = await ensureHelperRunningOrSkip('A9');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A9', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.future], name: 'A9' });
            const hour = new Date().getHours();
            addSchedule(bl.id, [{
                startHour: hour,
                startMinute: 0,
                endHour: (hour + 1) % 24,
                endMinute: 0,
                days: [currentDayMon0()]
            }]);
            await callSaveData();
            await callUpdateHostsFile();

            await setSchedulePaused(bl.id, 1200);
            await shortWait(2500);
            const appData = getAppData();
            const refreshed = (appData.schedules || []).find(s => s.blocklistId === bl.id);
            assertOrThrow(refreshed, 'A9: schedule missing after pause expiry wait');
            assertOrThrow(!refreshed.isPaused, 'A9: schedule pause should naturally expire');
            assertOrThrow(!refreshed.pauseEndTime, 'A9: schedule pauseEndTime should be cleared after natural expiry');
            const result = await callUpdateHostsFile();
            assertOrThrow(result && result.success, 'A9: post-expiry update failed');
            await assertEnforcedDomain('A9', TEST_DOMAINS.future);
            return { passed: true };
        });
    }

    async function testA10_pauseInactiveScheduleSuppressionPath() {
        const skip = await ensureHelperRunningOrSkip('A10');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A10', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a, TEST_DOMAINS.future], name: 'A10' });
            const now = new Date();
            const startMinute = (now.getMinutes() + 1) % 60;
            const endMinute = (startMinute + 30) % 60;
            const startHour = startMinute < now.getMinutes() ? (now.getHours() + 1) % 24 : now.getHours();
            const endHour = endMinute < startMinute ? (startHour + 1) % 24 : startHour;

            addSchedule(bl.id, [{
                startHour,
                startMinute,
                endHour,
                endMinute,
                days: [currentDayMon0()]
            }]);
            await callSaveData();
            await callUpdateHostsFile();
            await assertNotEnforcedDomain('A10', TEST_DOMAINS.a);
            await assertNotEnforcedDomain('A10', TEST_DOMAINS.future);

            const pausedSchedule = await setSchedulePaused(bl.id, 120000);
            assertOrThrow(!!pausedSchedule.isPaused, 'A10: schedule should be paused while inactive');
            assertOrThrow(pausedSchedule.pauseEndTime > nowMs(), 'A10: schedule pause should suppress upcoming activation window');
            await assertNotEnforcedDomain('A10', TEST_DOMAINS.a);
            await assertNotEnforcedDomain('A10', TEST_DOMAINS.future);

            const resumedSchedule = await clearSchedulePause(bl.id);
            assertOrThrow(!resumedSchedule.isPaused, 'A10: schedule should resume from suppressed state');
            assertOrThrow(!resumedSchedule.pauseEndTime, 'A10: resumed schedule pause end should be cleared');
            await assertNotEnforcedDomain('A10', TEST_DOMAINS.a);
            await assertNotEnforcedDomain('A10', TEST_DOMAINS.future);
            return { passed: true };
        });
    }

    // A11: On v3 there is no helper daemon — the saved data file is the single
    // source of truth for enforcement, and the legacy `set_blocks_via_helper`
    // shim is a pure acknowledgment. Pins that ownership: a block pushed only
    // through the shim (never written to appData/save_data) must have zero
    // effect on derived enforcement, while the same block through the real
    // save path enforces immediately.
    async function testA11_dataFileOwnsEnforcement() {
        const skip = await ensureHelperRunningOrSkip('A11');
        if (skip) return skip;

        return runIsolatedIntegrationTest('A11', async () => {
            const tauriAPI = getTauriAPI();

            const setResult = await tauriAPI.setBlocksViaHelper([{
                domains: [TEST_DOMAINS.a],
                endTime: nowMs() + 120000,
                blocklistId: makeId('bl-a11')
            }]);
            assertOrThrow(setResult && setResult.success, 'A11: setBlocks shim ack failed');
            await assertNotEnforcedDomain('A11', TEST_DOMAINS.a);

            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'A11' });
            addActiveBlock(bl.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();
            await assertEnforcedDomain('A11', TEST_DOMAINS.a);
            return { passed: true };
        });
    }

    // ========================================
    // Testing Group B: Multi-block overlap correctness
    // ========================================

    async function testB1_sharedDomainOverlap() {
        const skip = await ensureHelperRunningOrSkip('B1');
        if (skip) return skip;

        const bl1 = addTestBlocklist({ websites: [TEST_DOMAINS.a, TEST_DOMAINS.shared], name: 'B1-A' });
        const bl2 = addTestBlocklist({ websites: [TEST_DOMAINS.b, TEST_DOMAINS.shared], name: 'B1-B' });
        addActiveBlock(bl1.id, { durationMs: 120000 });
        addActiveBlock(bl2.id, { durationMs: 120000 });
        await callSaveData();

        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'B1: overlap update failed');
        await assertEnforcedDomain('B1', TEST_DOMAINS.a);
        await assertEnforcedDomain('B1', TEST_DOMAINS.b);
        await assertEnforcedDomain('B1', TEST_DOMAINS.shared);
        return { passed: true };
    }

    async function testB2_oneOffPlusScheduleSameBlocklist() {
        const skip = await ensureHelperRunningOrSkip('B2');
        if (skip) return skip;

        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a, TEST_DOMAINS.shared], name: 'B2' });
        addActiveBlock(bl.id, { durationMs: 120000 });
        const hour = new Date().getHours();
        addSchedule(bl.id, [{
            startHour: hour,
            startMinute: 0,
            endHour: (hour + 1) % 24,
            endMinute: 0,
            days: [currentDayMon0()]
        }]);
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'B2: one-off + schedule merge failed');
        await assertEnforcedDomain('B2', TEST_DOMAINS.a);
        await assertEnforcedDomain('B2', TEST_DOMAINS.shared);

        // v3 clear path: the shim command is an ack; the real clear is the
        // frontend removing the block and saving (backends re-derive).
        const tauriAPI = getTauriAPI();
        const clearResult = await tauriAPI.clearBlockViaHelper(bl.id);
        assertOrThrow(clearResult && clearResult.success, 'B2: clear shim ack failed');
        const appData = getAppData();
        appData.activeBlocks = appData.activeBlocks.filter(b => b.blocklistId !== bl.id);
        await callSaveData();
        const syncResult = await callUpdateHostsFile();
        assertOrThrow(syncResult && syncResult.success, 'B2: sync after one-off clear failed');
        // Schedule segment still active → both domains stay enforced.
        await assertEnforcedDomain('B2', TEST_DOMAINS.a);
        await assertEnforcedDomain('B2', TEST_DOMAINS.shared);
        return { passed: true };
    }

    // ========================================
    // Testing Group C: Clear and override semantics
    // ========================================

    async function testC1_scopedClearByBlocklistId() {
        const skip = await ensureHelperRunningOrSkip('C1');
        if (skip) return skip;

        await resetIntegrationTestState('C1');
        const tauriAPI = getTauriAPI();
        const bl1 = addTestBlocklist({ websites: [TEST_DOMAINS.a, TEST_DOMAINS.shared], name: 'C1-A' });
        const bl2 = addTestBlocklist({ websites: [TEST_DOMAINS.b, TEST_DOMAINS.shared], name: 'C1-B' });
        addActiveBlock(bl1.id, { durationMs: 120000 });
        addActiveBlock(bl2.id, { durationMs: 120000 });
        await callSaveData();
        await callUpdateHostsFile();
        await assertEnforcedDomain('C1', TEST_DOMAINS.a);
        await assertEnforcedDomain('C1', TEST_DOMAINS.b);
        await assertEnforcedDomain('C1', TEST_DOMAINS.shared);

        // v3 scoped clear: shim command is an ack; the frontend removes the
        // blocklist's blocks and saves, and backends re-derive from the file.
        const scopedResult = await tauriAPI.clearBlockViaHelper(bl1.id);
        assertOrThrow(scopedResult && scopedResult.success, 'C1: clear shim ack failed');
        const appData = getAppData();
        appData.activeBlocks = appData.activeBlocks.filter(b => b.blocklistId !== bl1.id);
        await callSaveData();
        await callUpdateHostsFile();
        await assertNotEnforcedDomain('C1', TEST_DOMAINS.a);
        await assertEnforcedDomain('C1', TEST_DOMAINS.b);
        await assertEnforcedDomain('C1', TEST_DOMAINS.shared);
        return { passed: true };
    }

    async function testC2_clearAllManualBlocks() {
        const skip = await ensureHelperRunningOrSkip('C2');
        if (skip) return skip;

        await resetIntegrationTestState('C2');
        const tauriAPI = getTauriAPI();
        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'C2' });
        addActiveBlock(bl.id, { durationMs: 120000 });
        await callSaveData();
        await callUpdateHostsFile();
        await assertEnforcedDomain('C2', TEST_DOMAINS.a);

        // v3 clear-all: shim ack + frontend removes every manual block and saves.
        const clearAll = await tauriAPI.clearBlockViaHelper();
        assertOrThrow(clearAll && clearAll.success, 'C2: clear-all shim ack failed');
        const appData = getAppData();
        appData.activeBlocks = [];
        await callSaveData();
        await callUpdateHostsFile();
        await assertNotEnforcedDomain('C2', TEST_DOMAINS.a);
        return { passed: true };
    }

    async function testC3_maxDifficultyBlocklistStartClear() {
        const skip = await ensureHelperRunningOrSkip('C3');
        if (skip) return skip;

        await resetIntegrationTestState('C3');
        const tauriAPI = getTauriAPI();
        const bl = addTestBlocklist({
            websites: [TEST_DOMAINS.b],
            name: 'C3'
        });
        bl.overrideDifficulty = { type: 'random-words', count: 7500, maxDifficulty: true };
        addActiveBlock(bl.id, { durationMs: 120000 });
        await callSaveData();
        const startResult = await callUpdateHostsFile();
        assertOrThrow(startResult && startResult.success, 'C3: start block with max difficulty failed');
        await assertEnforcedDomain('C3', TEST_DOMAINS.b);

        const clearResult = await tauriAPI.clearBlockViaHelper(bl.id);
        assertOrThrow(clearResult && clearResult.success, 'C3: clear shim ack failed');
        const appData = getAppData();
        appData.activeBlocks = appData.activeBlocks.filter(b => b.blocklistId !== bl.id);
        await callSaveData();
        await callUpdateHostsFile();
        await assertNotEnforcedDomain('C3', TEST_DOMAINS.b);
        return { passed: true };
    }

    // ========================================
    // Testing Group G: Blocklist management
    // ========================================

    async function testG1_duplicateThenRun() {
        const skip = await ensureHelperRunningOrSkip('G1');
        if (skip) return skip;

        const internals = getInternals();
        const duplicateBlocklist = internals?.duplicateBlocklist;
        assertOrThrow(typeof duplicateBlocklist === 'function', 'G1: duplicateBlocklist not available');
        assertOrThrow(typeof internals.getNextCopyName === 'function', 'G1: getNextCopyName not available');

        const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'G1' });
        const expectedDupName = internals.getNextCopyName(bl);
        duplicateBlocklist(bl.id);

        const appData = getAppData();
        const duplicated = appData.blocklists.find(b => b.name === expectedDupName);
        assertOrThrow(duplicated, 'G1: duplicated blocklist not found');

        addActiveBlock(duplicated.id, { durationMs: 120000 });
        await callSaveData();
        const result = await callUpdateHostsFile();
        assertOrThrow(result && result.success, 'G1: start duplicate block failed');

        const tauriAPI = getTauriAPI();
        const clearResult = await tauriAPI.clearBlockViaHelper(duplicated.id);
        assertOrThrow(clearResult && clearResult.success, 'G1: scoped clear duplicate failed');

        appData.blocklists = appData.blocklists.filter(b => b.id !== duplicated.id);
        await callUpdateHostsFile(true);
        return { passed: true };
    }

    // ========================================
    // Testing Group D: Keep-blocking preference decision inputs
    // ========================================

    // ========================================
    // Testing Group E: Legacy-command and diagnostics invariants
    // ========================================

    // E1: `clean_hosts_file` is v1 migration cleanup (strips legacy markers if
    // present). v3 never writes hosts, so the contract is: command succeeds and
    // is idempotent — not that it changes enforcement.
    async function testE1_cleanHostsCommandPath() {
        const skip = await ensureHelperRunningOrSkip('E1');
        if (skip) return skip;

        const tauriAPI = getTauriAPI();
        const first = await tauriAPI.cleanHostsFile();
        assertOrThrow(first && first.success, 'E1: clean-hosts command failed');
        const second = await tauriAPI.cleanHostsFile();
        assertOrThrow(second && second.success, 'E1: clean-hosts command not idempotent');
        return { passed: true };
    }

    // E2: v3 diagnostics contract. `check_helper_status` reports the app itself
    // as the always-ready "helper"; `get_helper_diagnostics` returns the app
    // version + backend label (not the dead v1 daemon fields).
    async function testE2_helperDiagnosticsContract() {
        const skip = await ensureHelperRunningOrSkip('E2');
        if (skip) return skip;

        const tauriAPI = getTauriAPI();
        assertOrThrow(tauriAPI && typeof tauriAPI.getHelperDiagnostics === 'function', 'E2: getHelperDiagnostics unavailable');

        const status = await tauriAPI.checkHelperStatus();
        assertOrThrow(status.installed === true, 'E2: shim should always report installed');
        assertOrThrow(status.running === true, 'E2: shim should always report running');
        assertOrThrow(status.version_ok === true, 'E2: shim should always report version_ok');
        assertOrThrow(typeof status.version === 'string' && status.version.length > 0, 'E2: shim version missing');

        const diag = await tauriAPI.getHelperDiagnostics();
        assertOrThrow(diag, 'E2: diagnostics command returned nothing');
        assertOrThrow(diag.app_version === status.version, `E2: app_version mismatch (${diag.app_version} !== ${status.version})`);
        assertOrThrow(['automation', 'extension', 'unsupported'].includes(diag.backend), `E2: unexpected backend label (${diag.backend})`);
        return { passed: true };
    }

    // ========================================
    // Testing Group F: App-block command-path checks (non-visual)
    // ========================================

    async function testF1_setBlockedAppsCommandPath() {
        const skip = await ensureHelperRunningOrSkip('F1');
        if (skip) return skip;

        const tauriAPI = getTauriAPI();
        const result = await tauriAPI.setBlockedAppsViaHelper(['Calculator', 'Notes']);
        assertOrThrow(result && result.success, 'F1: set blocked apps failed');

        const clear = await tauriAPI.setBlockedAppsViaHelper([]);
        assertOrThrow(clear && clear.success, 'F1: clear blocked apps failed');
        return { passed: true };
    }

    async function testF2_protectedAppPayloadPath() {
        const skip = await ensureHelperRunningOrSkip('F2');
        if (skip) return skip;

        const tauriAPI = getTauriAPI();
        // Helper should filter protected app names safely and still succeed.
        const result = await tauriAPI.setBlockedAppsViaHelper(['redd-block-helper', 'Calculator']);
        assertOrThrow(result && result.success, 'F2: protected app payload command failed');
        await tauriAPI.setBlockedAppsViaHelper([]);
        return { passed: true };
    }

    // ========================================
    // Testing Group H: Allowlist mode (desktop websites channel)
    // ========================================
    //
    // Pipeline-state tests: real allow-mode focus spaces are created, started,
    // paused, and cleared through the same save + sync path users hit, and the
    // Rust-derived enforcement snapshot (`get_system_diagnostics.current_blocking`)
    // is asserted. Per-URL block/allow decisions and blocklist-wins subtraction
    // are decision-time logic covered by Rust unit tests (web_automation.rs) and
    // Tier 1 Category 14 — not re-tested here.
    //
    // Deliberately websites-only: enabling allow-mode APP enforcement would
    // enroll the tester's real open apps for quit. App allow-mode is manual
    // checklist territory (section 15).

    async function testH1_singleAllowlistEnforcementState() {
        const skip = await ensureHelperRunningOrSkip('H1');
        if (skip) return skip;

        return runIsolatedIntegrationTest('H1', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'H1 Allow', mode: 'allowlist' });
            addActiveBlock(bl.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();
            callRender();

            const cb = await getCurrentBlockingOrThrow('H1');
            assertOrThrow(!cb.domains.includes(TEST_DOMAINS.a), 'H1: allowlist domain must not appear in the flat blocked list');
            assertOrThrow(cb.allowed_domains.includes(TEST_DOMAINS.a), 'H1: allowed_domains missing the allowlist domain');
            const allowBlock = (cb.blocks || []).find(b => b.mode === 'allowlist' && (b.domains || []).includes(TEST_DOMAINS.a));
            assertOrThrow(allowBlock, 'H1: no allowlist-mode block entry in current_blocking.blocks');

            removeTestDataFromAppState();
            await callSaveData();
            await callUpdateHostsFile(true);
            callRender();
            const after = await getCurrentBlockingOrThrow('H1');
            assertOrThrow(!after.allowed_domains.includes(TEST_DOMAINS.a), 'H1: allowed_domains not cleared after stop');
            return { passed: true };
        });
    }

    async function testH2_concurrentAllowlistsUnion() {
        const skip = await ensureHelperRunningOrSkip('H2');
        if (skip) return skip;

        return runIsolatedIntegrationTest('H2', async () => {
            const blA = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'H2 Allow A', mode: 'allowlist' });
            const blB = addTestBlocklist({ websites: [TEST_DOMAINS.b], name: 'H2 Allow B', mode: 'allowlist' });
            addActiveBlock(blA.id, { durationMs: 120000 });
            addActiveBlock(blB.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();
            callRender();

            const cb = await getCurrentBlockingOrThrow('H2');
            assertOrThrow(cb.allowed_domains.includes(TEST_DOMAINS.a), 'H2: allowed union missing first allowlist domain');
            assertOrThrow(cb.allowed_domains.includes(TEST_DOMAINS.b), 'H2: allowed union missing second allowlist domain');
            const allowEntries = (cb.blocks || []).filter(b => b.mode === 'allowlist');
            assertOrThrow(allowEntries.length >= 2, `H2: expected 2 allowlist block entries, got ${allowEntries.length}`);
            return { passed: true };
        });
    }

    async function testH3_allowlistBlocklistOverlap() {
        const skip = await ensureHelperRunningOrSkip('H3');
        if (skip) return skip;

        return runIsolatedIntegrationTest('H3', async () => {
            const allowBl = addTestBlocklist({ websites: [TEST_DOMAINS.a, TEST_DOMAINS.b], name: 'H3 Allow', mode: 'allowlist' });
            const blockBl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'H3 Block' });
            addActiveBlock(allowBl.id, { durationMs: 120000 });
            addActiveBlock(blockBl.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();
            callRender();

            const cb = await getCurrentBlockingOrThrow('H3');
            // Both channels intact: the blocklist domain still rides the flat
            // blocked list (blocklist wins at decision time), and the allowlist
            // union is surfaced alongside it.
            assertOrThrow(cb.domains.includes(TEST_DOMAINS.a), 'H3: overlapping blocklist domain missing from flat blocked list');
            assertOrThrow(cb.allowed_domains.includes(TEST_DOMAINS.b), 'H3: non-overlapping allowlist domain missing from allowed union');
            const modes = new Set((cb.blocks || []).map(b => b.mode || 'blocklist'));
            assertOrThrow(modes.has('allowlist'), 'H3: allowlist block entry missing');
            assertOrThrow(modes.has('blocklist') || modes.has('manual'), 'H3: blocklist block entry missing');
            return { passed: true };
        });
    }

    async function testH4_pauseResumeAllowlistEnforcementPath() {
        const skip = await ensureHelperRunningOrSkip('H4');
        if (skip) return skip;

        return runIsolatedIntegrationTest('H4', async () => {
            const bl = addTestBlocklist({ websites: [TEST_DOMAINS.a], name: 'H4 Allow', mode: 'allowlist' });
            const block = addActiveBlock(bl.id, { durationMs: 120000 });
            await callSaveData();
            await callUpdateHostsFile();
            callRender();
            let cb = await getCurrentBlockingOrThrow('H4');
            assertOrThrow(cb.allowed_domains.includes(TEST_DOMAINS.a), 'H4: allowlist not enforced before pause');

            await setOneOffPaused(block.id, 45000);
            callRender();
            cb = await getCurrentBlockingOrThrow('H4');
            assertOrThrow(!cb.allowed_domains.includes(TEST_DOMAINS.a), 'H4: paused allowlist still in allowed union');
            assertOrThrow(!(cb.blocks || []).some(b => b.mode === 'allowlist'), 'H4: paused allowlist still has a block entry');

            await clearOneOffPause(block.id);
            callRender();
            cb = await getCurrentBlockingOrThrow('H4');
            assertOrThrow(cb.allowed_domains.includes(TEST_DOMAINS.a), 'H4: resumed allowlist missing from allowed union');
            return { passed: true };
        });
    }

    function buildProfileTests(profile) {
        const coreTests = [
            { group: 'A', name: 'A1: Enforcement derivation path', fn: testA1_enforcementDerivationPath },
            { group: 'A', name: 'A2: One-off start/end timing', fn: testA2_blockStartEndTiming },
            { group: 'A', name: 'A3: Schedule active-now path', fn: testA3_scheduleActiveNow },
            { group: 'A', name: 'A6: Pause/resume one-off enforcement path', fn: testA6_pauseResumeOneOffEnforcementPath },
            { group: 'B', name: 'B1: Shared-domain overlap', fn: testB1_sharedDomainOverlap },
            { group: 'C', name: 'C1: Scoped clear by blocklist ID', fn: testC1_scopedClearByBlocklistId },
            { group: 'E', name: 'E1: Clean hosts command path', fn: testE1_cleanHostsCommandPath },
            { group: 'E', name: 'E2: Helper diagnostics contract', fn: testE2_helperDiagnosticsContract },
            { group: 'H', name: 'H1: Single allowlist enforcement state', fn: testH1_singleAllowlistEnforcementState }
        ];

        if (profile === PROFILE_CORE) return coreTests;

        return [
            ...coreTests,
            { group: 'A', name: 'A4: Future schedule path', fn: testA4_futureScheduleDoesNotThrow },
            { group: 'A', name: 'A5: Pause/resume one-off state path', fn: testA5_pauseResumeOneOffStatePath },
            { group: 'A', name: 'A7: Pause natural-expiry one-off smoke', fn: testA7_pauseNaturalExpiryOneOffSmoke },
            { group: 'A', name: 'A8: Pause/resume schedule active path', fn: testA8_pauseResumeScheduleActivePath },
            { group: 'A', name: 'A9: Pause natural-expiry schedule smoke', fn: testA9_pauseNaturalExpiryScheduleSmoke },
            { group: 'A', name: 'A10: Pause inactive schedule suppression path', fn: testA10_pauseInactiveScheduleSuppressionPath },
            { group: 'A', name: 'A11: Data file owns enforcement', fn: testA11_dataFileOwnsEnforcement },
            { group: 'B', name: 'B2: One-off + schedule same blocklist', fn: testB2_oneOffPlusScheduleSameBlocklist },
            { group: 'C', name: 'C2: Clear-all manual blocks', fn: testC2_clearAllManualBlocks },
            { group: 'C', name: 'C3: Max difficulty blocklist start/clear', fn: testC3_maxDifficultyBlocklistStartClear },
            { group: 'F', name: 'F1: Set blocked apps command path', fn: testF1_setBlockedAppsCommandPath },
            { group: 'F', name: 'F2: Protected app payload path', fn: testF2_protectedAppPayloadPath },
            { group: 'G', name: 'G1: Duplicate blocklist then start/clear path', fn: testG1_duplicateThenRun },
            { group: 'H', name: 'H2: Concurrent allowlists union', fn: testH2_concurrentAllowlistsUnion },
            { group: 'H', name: 'H3: Allowlist + blocklist overlap', fn: testH3_allowlistBlocklistOverlap },
            { group: 'H', name: 'H4: Pause/resume allowlist enforcement path', fn: testH4_pauseResumeAllowlistEnforcementPath }
        ];
    }

    // ========================================
    // MAIN RUNNER
    // ========================================

    async function runIntegrationTests(profile = PROFILE_CORE) {
        const selectedProfile = profile === PROFILE_FULL ? PROFILE_FULL : PROFILE_CORE;

        console.clear();
        console.log('🔬 ReddBlock Tier 2 Integration Tests');
        console.log('=====================================');
        console.log(`Profile: ${selectedProfile}`);
        console.log('⚠️  These tests modify real system state.\n');

        if (!getInternals()) {
            console.error('❌ App internals not available.');
            console.log('   Make sure app.js has loaded and exposes __REDDBLOCK_INTERNALS__');
            return { passed: 0, failed: 0, skipped: 0, errors: ['Internals not available'], profile: selectedProfile };
        }

        const results = { passed: 0, failed: 0, skipped: 0, errors: [], profile: selectedProfile };
        const tests = buildProfileTests(selectedProfile);
        const groupResults = new Map();

        try {
            await setupSuite();

            for (const test of tests) {
                const groupKey = test.group || 'Unknown';
                const groupState = groupResults.get(groupKey) || {
                    total: 0,
                    passed: 0,
                    failed: 0,
                    skipped: 0,
                    failures: []
                };
                groupState.total++;
                const r = await runCase(test.name, test.fn);
                if (r.status === 'passed') {
                    results.passed++;
                    groupState.passed++;
                    console.log(`✅ ${test.name}`);
                } else if (r.status === 'skipped') {
                    results.skipped++;
                    groupState.skipped++;
                    console.log(`⏭️  ${test.name} (skipped: ${r.error})`);
                } else {
                    results.failed++;
                    groupState.failed++;
                    groupState.failures.push(`${test.name}: ${r.error}`);
                    results.errors.push(`${test.name}: ${r.error}`);
                    console.error(`❌ ${test.name}: ${r.error}`);
                }
                groupResults.set(groupKey, groupState);
            }
        } catch (err) {
            console.error('❌ Test suite crashed:', err);
            results.errors.push('Suite crash: ' + (err?.message || String(err)));
        } finally {
            await teardownSuite();
        }

        console.log('\n========================================');
        console.log(`TIER 2 RESULTS (${selectedProfile.toUpperCase()}):`);
        console.log(`  ✅ Passed: ${results.passed}`);
        console.log(`  ❌ Failed: ${results.failed}`);
        console.log(`  ⏭️  Skipped: ${results.skipped}`);
        console.log('========================================');

        if (results.errors.length > 0) {
            console.log('\nErrors:');
            results.errors.forEach(e => console.log('  • ' + e));
        }

        if (selectedProfile === PROFILE_FULL && results.failed > 0) {
            console.log('\nGroup failure summary (full profile):');
            ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach(groupKey => {
                const g = groupResults.get(groupKey);
                if (!g) return;
                const passedOverTotal = `${g.passed}/${g.total}`;
                if (g.failed > 0) {
                    const failureDetail = g.failures.join(' | ');
                    console.log(`  Group ${groupKey}: ${passedOverTotal} tests passed, ${g.failed} failed [${failureDetail}]`);
                } else {
                    console.log(`  Group ${groupKey}: ${passedOverTotal} tests passed`);
                }
            });
        }
        return results;
    }

    // Export
    window.runIntegrationTests = runIntegrationTests;
    window.runIntegrationTestsFull = () => runIntegrationTests(PROFILE_FULL);

    console.log("🔬 Tier 2 integration tests loaded. Run with:");
    console.log("   runIntegrationTests('core')  // default fast profile");
    console.log("   runIntegrationTests('full')  // expanded profile");
    console.log('   ⚠️  These tests modify real system state!');
})();
