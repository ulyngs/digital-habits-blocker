/**
 * ReddBlock Blocking Tests
 * 
 * Automated tests for blocking functionality.
 * Run via Cmd+Shift+T in dev mode.
 * 
 * Test Categories:
 * - T1-T9: Time-based scenarios
 * - T9a-T9d: Pause-aware and all-day enforcement semantics
 * - T10-T13: Overlap & union scenarios
 * - T14-T17: Shared domain edge cases
 * - T18-T21: Override behavior
 * - T22-T25: App blocking (manual only - requires system interaction)
 * - T26-T32: Override All feature
 * - T38c-T38e: Max difficulty (effective count)
 * - T43-T47: Self-Block Prevention
 * - T48-T50: Protected Domain Prevention
 * - T51-T54, T51da: Blocklist duplication (schedules copy as pending drafts; DA uses "kopi")
 * - T55-T62: iOS allowlist effective-policy resolvers (pure helpers)
 */

(function () {
    'use strict';

    // Wait for test utils to load
    if (!window.ReddBlockTestUtils) {
        console.error('❌ Test utils not loaded. Make sure test-utils.js is included.');
        return;
    }

    const {
        createMockDate,
        createMockNow,
        createMockBlocklist,
        createMockBlock,
        createMockSchedule,
        createMockSegment,
        createMockAppData,
        getBlockedDomains,
        getHardestChallenge,
        compareDifficulties,
        hasAnyActiveBlocks,
        findHardestChallengeAtTime,
        simulateOverrideAll,
        resetTestResults,
        assert,
        assertEqual,
        assertSetEquals,
        assertSetContains,
        assertSetEmpty,
        printTestSummary
    } = window.ReddBlockTestUtils;

    // ========================================
    // CATEGORY 1: TIME-BASED SCENARIOS
    // ========================================

    function runTimeBasedTests() {
        console.log('\n📅 Category 1: Time-Based Scenarios');
        console.log('----------------------------------');

        // T1: No blocks active
        (function T1() {
            const appData = createMockAppData();
            const now = Date.now();
            const nowDate = new Date(now);

            const domains = getBlockedDomains(appData, now, nowDate);
            assertSetEmpty(domains, 'T1: No blocks → no domains blocked');
        })();

        // T2: One-off block within time window
        (function T2() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com'] });
            const now = Date.now();
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000); // Active now

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'facebook.com', 'T2: One-off within window → blocked');
        })();

        // T3: One-off not started yet
        (function T3() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com'] });
            const now = Date.now();
            const block = createMockBlock(blocklist.id, now + 60000, now + 120000); // Future

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T3: One-off not started → not blocked');
        })();

        // T4: One-off expired
        (function T4() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com'] });
            const now = Date.now();
            const block = createMockBlock(blocklist.id, now - 120000, now - 60000); // Past

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T4: One-off expired → not blocked');
        })();

        // T5: One-off crosses midnight (22:00→03:00), test at 01:00
        (function T5() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com'] });
            // Create timestamps: block from 22:00 yesterday to 03:00 today
            const testTime = createMockDate(1, 0, 1); // 01:00 on Monday
            const startTime = new Date(testTime);
            startTime.setDate(startTime.getDate() - 1);
            startTime.setHours(22, 0, 0, 0);
            const endTime = new Date(testTime);
            endTime.setHours(3, 0, 0, 0);

            const block = createMockBlock(blocklist.id, startTime.getTime(), endTime.getTime());

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetContains(domains, 'facebook.com', 'T5: One-off crosses midnight, test at 01:00 → blocked');
        })();

        // T6: Schedule active segment, correct day/time
        (function T6() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(9, 0, 17, 0, [0, 1, 2, 3, 4]); // Mon-Fri 9-17
            const schedule = createMockSchedule(blocklist.id, [segment]);

            // Test at 10:00 on Monday (day 0 in app format)
            const testTime = createMockDate(10, 0, 1); // Monday in JS = day 1

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetContains(domains, 'youtube.com', 'T6: Schedule active on correct day/time → blocked');
        })();

        // T7: Schedule wrong day
        (function T7() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(9, 0, 17, 0, [0, 1, 2, 3, 4]); // Mon-Fri only
            const schedule = createMockSchedule(blocklist.id, [segment]);

            // Test at 10:00 on Saturday (day 5 in app format)
            const testTime = createMockDate(10, 0, 6); // Saturday in JS = day 6

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetEmpty(domains, 'T7: Schedule wrong day → not blocked');
        })();

        // T8: Schedule right day, outside time window
        (function T8() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(9, 0, 17, 0, [0]); // Monday 9-17
            const schedule = createMockSchedule(blocklist.id, [segment]);

            // Test at 20:00 on Monday
            const testTime = createMockDate(20, 0, 1); // Monday in JS

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetEmpty(domains, 'T8: Schedule outside time window → not blocked');
        })();

        // T9: Schedule crosses midnight (21:00→04:00), test at 02:00
        (function T9() {
            const blocklist = createMockBlocklist({ websites: ['netflix.com'] });
            // Tuesday night (day 1) 21:00 to Wednesday morning 04:00
            const segment = createMockSegment(21, 0, 4, 0, [1]); // Tuesday
            const schedule = createMockSchedule(blocklist.id, [segment]);

            // Test at 02:00 on Wednesday (should be blocked because Tuesday is in days)
            const testTime = createMockDate(2, 0, 3); // Wednesday in JS = day 3

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetContains(domains, 'netflix.com', 'T9: Schedule crosses midnight, test at 02:00 → blocked');
        })();

        // T9a: All-day schedule (start == end) is active for that day
        (function T9a() {
            const blocklist = createMockBlocklist({ websites: ['all-day.com'] });
            const segment = createMockSegment(9, 0, 9, 0, [0]); // Monday all day
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const testTime = createMockDate(15, 30, 1); // Monday 15:30

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetContains(domains, 'all-day.com', 'T9a: All-day schedule stays enforced on its day');
        })();

        // T9b: Paused one-off block is excluded from enforcement
        (function T9b() {
            const blocklist = createMockBlocklist({ websites: ['paused-oneoff.com'] });
            const now = Date.now();
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000, {
                isPaused: true,
                pauseEndTime: now + 60000
            });

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T9b: Paused one-off does not contribute blocked domains');
        })();

        // T9c: Paused schedule is excluded from enforcement
        (function T9c() {
            const blocklist = createMockBlocklist({ websites: ['paused-schedule.com'] });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const now = Date.now();
            const schedule = createMockSchedule(blocklist.id, [segment], {
                isPaused: true,
                pauseEndTime: now + 60000
            });

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T9c: Paused schedule does not contribute blocked domains');
        })();

        // T9d: Schedule paused before segment start suppresses the upcoming segment while pause remains active
        (function T9d() {
            const blocklist = createMockBlocklist({ websites: ['suppressed-segment.com'] });
            const testTime = createMockDate(10, 30, 1); // Monday 10:30
            const pauseEndTime = createMockDate(11, 0, 1).getTime(); // Pause still active during 10:00-12:00 segment
            const segment = createMockSegment(10, 0, 12, 0, [0]); // Monday
            const schedule = createMockSchedule(blocklist.id, [segment], {
                isPaused: true,
                pauseEndTime
            });

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetEmpty(domains, 'T9d: Paused schedule suppresses the would-be active segment');
        })();
    }

    // ========================================
    // CATEGORY 2: OVERLAP & UNION SCENARIOS
    // ========================================

    function runOverlapTests() {
        console.log('\n🔀 Category 2: Overlap & Union Scenarios');
        console.log('----------------------------------------');

        // T10: One-off + schedule different blocklists
        (function T10() {
            const blocklist1 = createMockBlocklist({ websites: ['facebook.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['youtube.com'] });

            const now = Date.now();
            const block = createMockBlock(blocklist1.id, now - 60000, now + 60000);

            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]); // All day every day
            const schedule = createMockSchedule(blocklist2.id, [segment]);

            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [block],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assert(domains.size === 2, 'T10: One-off + schedule → union (2 domains)');
            assertSetContains(domains, 'facebook.com', 'T10: facebook.com blocked');
            assertSetContains(domains, 'youtube.com', 'T10: youtube.com blocked');
        })();

        // T11: One-off + schedule same blocklist
        (function T11() {
            const blocklist = createMockBlocklist({ websites: ['twitter.com', 'instagram.com'] });

            const now = Date.now();
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000);

            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule = createMockSchedule(blocklist.id, [segment]);

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            // Same blocklist, so still just 2 unique domains
            assert(domains.size === 2, 'T11: Same blocklist both active → domains from that list');
        })();

        // T12: Multiple schedules, all active
        (function T12() {
            const blocklist1 = createMockBlocklist({ websites: ['site1.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['site2.com'] });
            const blocklist3 = createMockBlocklist({ websites: ['site3.com'] });

            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule1 = createMockSchedule(blocklist1.id, [segment]);
            const schedule2 = createMockSchedule(blocklist2.id, [segment]);
            const schedule3 = createMockSchedule(blocklist3.id, [segment]);

            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2, blocklist3],
                schedules: [schedule1, schedule2, schedule3]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertEqual(domains.size, 3, 'T12: Multiple schedules active → union of all (3)');
        })();

        // T13: One-off ends, overlapping schedule continues
        (function T13() {
            const blocklist1 = createMockBlocklist({ websites: ['facebook.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['youtube.com'] });

            const now = Date.now();
            // One-off has ENDED
            const block = createMockBlock(blocklist1.id, now - 120000, now - 60000);

            // Schedule still active
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule = createMockSchedule(blocklist2.id, [segment]);

            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [block],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assert(!domains.has('facebook.com'), 'T13: One-off ended → its domain not blocked');
            assertSetContains(domains, 'youtube.com', 'T13: Schedule still blocks its domains');
        })();
    }

    // ========================================
    // CATEGORY 3: SHARED DOMAIN EDGE CASES
    // ========================================

    function runSharedDomainTests() {
        console.log('\n🔗 Category 3: Shared Domain Edge Cases');
        console.log('---------------------------------------');

        // T14: Two blocklists with overlapping domain, both active
        (function T14() {
            const blocklist1 = createMockBlocklist({
                websites: ['ulriklyngs.com', 'katyperry.com']
            });
            const blocklist2 = createMockBlocklist({
                websites: ['ulriklyngs.com', 'andykaufman.com']
            });

            const now = Date.now();
            const block1 = createMockBlock(blocklist1.id, now - 60000, now + 60000);
            const block2 = createMockBlock(blocklist2.id, now - 60000, now + 60000);

            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [block1, block2]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertEqual(domains.size, 3, 'T14: Both active → all 3 unique domains blocked');
            assertSetContains(domains, 'ulriklyngs.com', 'T14: shared domain blocked');
        })();

        // T15: Same as T14, Block A ends
        (function T15() {
            const blocklist1 = createMockBlocklist({
                websites: ['ulriklyngs.com', 'katyperry.com']
            });
            const blocklist2 = createMockBlocklist({
                websites: ['ulriklyngs.com', 'andykaufman.com']
            });

            const now = Date.now();
            const block1 = createMockBlock(blocklist1.id, now - 120000, now - 60000); // ENDED
            const block2 = createMockBlock(blocklist2.id, now - 60000, now + 60000); // Still active

            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [block1, block2]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assert(!domains.has('katyperry.com'), 'T15: Block A ended → katyperry.com unblocked');
            assertSetContains(domains, 'ulriklyngs.com', 'T15: Shared domain still blocked by B');
            assertSetContains(domains, 'andykaufman.com', 'T15: Block B domain still blocked');
        })();

        // T16: Same blocklist - one-off + schedule both active, one-off removed
        (function T16() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com', 'twitter.com'] });

            const now = Date.now();
            // One-off has ended (simulating override)
            const block = createMockBlock(blocklist.id, now - 120000, now - 60000);

            // Schedule still active
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule = createMockSchedule(blocklist.id, [segment]);

            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block], // One-off removed
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'facebook.com', 'T16: Schedule continues blocking after one-off removed');
            assertSetContains(domains, 'twitter.com', 'T16: All blocklist domains still blocked');
        })();

        // T17: Same blocklist - one-off + schedule, schedule removed
        (function T17() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com', 'twitter.com'] });

            const now = Date.now();
            // One-off still active
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000);

            // Schedule removed (empty)
            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block],
                schedules: [] // Schedule removed via override
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'facebook.com', 'T17: One-off continues blocking after schedule removed');
        })();
    }

    // ========================================
    // CATEGORY 4: OVERRIDE BEHAVIOR
    // ========================================

    function runOverrideTests() {
        console.log('\n🔓 Category 4: Override Behavior');
        console.log('--------------------------------');

        // T18: Override one-off while schedule (different blocklist) runs
        (function T18() {
            const blocklist1 = createMockBlocklist({ websites: ['facebook.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['youtube.com'] });

            const now = Date.now();
            // One-off was overridden (removed)

            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule = createMockSchedule(blocklist2.id, [segment]);

            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [], // One-off removed
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'youtube.com', 'T18: Schedule still blocks after one-off override');
            assert(!domains.has('facebook.com'), 'T18: One-off domain unblocked');
        })();

        // T19: Override schedule while one-off runs
        (function T19() {
            const blocklist1 = createMockBlocklist({ websites: ['facebook.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['youtube.com'] });

            const now = Date.now();
            const block = createMockBlock(blocklist1.id, now - 60000, now + 60000);

            // Schedule was overridden (removed)
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [block],
                schedules: [] // Schedule removed
            });

            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'facebook.com', 'T19: One-off still blocks after schedule override');
            assert(!domains.has('youtube.com'), 'T19: Schedule domain unblocked');
        })();

        // T20: Override "just this block" in schedule (remove one segment's day)
        (function T20() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });

            // Originally had Mon, Tue, Wed but user removed just Tuesday
            const segment = createMockSegment(9, 0, 17, 0, [0, 2]); // Mon, Wed only now
            const schedule = createMockSchedule(blocklist.id, [segment]);

            // Test at 10:00 on Tuesday - should NOT be blocked anymore
            const testTime = createMockDate(10, 0, 2); // Tuesday

            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });

            const domains = getBlockedDomains(appData, testTime.getTime(), testTime);
            assertSetEmpty(domains, 'T20: Removed Tuesday from segment → not blocked on Tuesday');
        })();

        // T21: "Stop entire schedule" - all segments removed
        (function T21() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });

            // Schedule completely removed
            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: []
            });

            const now = Date.now();
            const domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T21: Schedule stopped → no domains blocked');
        })();
    }

    // ========================================
    // CATEGORY 5: APP BLOCKING
    // (Manual tests only - require system interaction)
    // ========================================

    function runAppBlockingTests() {
        console.log('\n📱 Category 5: App Blocking');
        console.log('---------------------------');
        console.log('⚠️  T22-T25 require manual testing (system interaction)');
        console.log('   See manual-test-checklist.md for instructions');
    }

    // ========================================
    // CATEGORY 6: OVERRIDE ALL BLOCKS
    // ========================================

    function runOverrideAllTests() {
        console.log('\n🔴 Category 6: Override All Blocks');
        console.log('-----------------------------------');

        // T26: Override All with one-off only
        (function T26() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com'] });
            const now = Date.now();

            // Before override all
            let appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [createMockBlock(blocklist.id, now - 60000, now + 60000)]
            });

            let domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'facebook.com', 'T26: Before override, site blocked');

            // Simulate override all - clears activeBlocks
            appData.activeBlocks = [];
            domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T26: After override all, no sites blocked');
        })();

        // T27: Override All with schedule only
        (function T27() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);

            let appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [createMockSchedule(blocklist.id, [segment])]
            });

            const now = Date.now();
            let domains = getBlockedDomains(appData, now, new Date(now));
            assertSetContains(domains, 'youtube.com', 'T27: Before override, site blocked');

            // Simulate override all - clears schedules
            appData.schedules = [];
            domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T27: After override all, no sites blocked');
        })();

        // T28: Override All with mixed (one-off + schedule)
        (function T28() {
            const blocklist1 = createMockBlocklist({ websites: ['facebook.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const now = Date.now();

            let appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [createMockBlock(blocklist1.id, now - 60000, now + 60000)],
                schedules: [createMockSchedule(blocklist2.id, [segment])]
            });

            let domains = getBlockedDomains(appData, now, new Date(now));
            assertEqual(domains.size, 2, 'T28: Before override, 2 sites blocked');

            // Simulate override all - clears both
            appData.activeBlocks = [];
            appData.schedules = [];
            domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T28: After override all, all cleared');
        })();

        // T29: Hardest challenge selection - highest count wins
        (function T29() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 30 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 100 }
            });

            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000)
                ]
            });

            const hardest = getHardestChallenge(appData, now);
            assertEqual(hardest.count, 100, 'T29: Highest count (100) selected');
        })();

        // T30: Gibberish vs random-words at same count
        (function T30() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 50 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 50 }
            });

            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000)
                ]
            });

            const hardest = getHardestChallenge(appData, now);
            assertEqual(hardest.type, 'gibberish', 'T30: Gibberish selected as harder at same count');
        })();

        // T31: Custom text challenge
        (function T31() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 50 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'custom', customText: 'This is a very long custom override text that is hard to type' }
            });

            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000)
                ]
            });

            const hardest = getHardestChallenge(appData, now);
            assertEqual(hardest.type, 'custom', 'T31: Custom text selected (longer than 50)');
        })();

        // T31b: Lower-than-50 active difficulties should not lose to default baseline
        (function T31b() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 20 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 30 }
            });

            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000)
                ]
            });

            const hardest = getHardestChallenge(appData, now);
            assertEqual(hardest.type, 'gibberish', 'T31b: Active 30-char gibberish selected over baseline default');
            assertEqual(hardest.count, 30, 'T31b: Selected count reflects active block, not default 50');
        })();

        // T31c: Equal character count tie should prefer custom over gibberish/random-words
        (function T31c() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 50 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 50 }
            });
            const blocklist3 = createMockBlocklist({
                overrideDifficulty: { type: 'custom', customText: 'x'.repeat(50) }
            });

            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2, blocklist3],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000),
                    createMockBlock(blocklist3.id, now - 60000, now + 60000)
                ]
            });

            const hardest = getHardestChallenge(appData, now);
            assertEqual(hardest.type, 'custom', 'T31c: Custom wins tie at equal character count');
            assertEqual(hardest.customText.length, 50, 'T31c: Custom count participates in equality tie');
        })();

        // T32: App blocking also stops (can only verify data state, not actual process watcher)
        (function T32() {
            console.log('   T32: App blocking stop verified via manual testing');
            assert(true, 'T32: Placeholder - requires manual verification');
        })();
    }

    // ========================================
    // CATEGORY 7: hasAnyActiveBlocks
    // ========================================

    function runHasAnyActiveBlocksTests() {
        console.log('\n🔍 Category 7: hasAnyActiveBlocks');
        console.log('----------------------------------');

        // T33: No blocks, no schedules
        (function T33() {
            const appData = createMockAppData();
            const now = Date.now();
            const result = hasAnyActiveBlocks(appData, now, new Date(now));
            assert(result === false, 'T33: No blocks/schedules → false');
        })();

        // T34: Active one-off block
        (function T34() {
            const blocklist = createMockBlocklist({ websites: ['facebook.com'] });
            const now = Date.now();
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000);
            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });
            const result = hasAnyActiveBlocks(appData, now, new Date(now));
            assert(result === true, 'T34: Active one-off → true');
        })();

        // T35: Active schedule on correct day/time
        (function T35() {
            const blocklist = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]); // All days
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });
            const result = hasAnyActiveBlocks(appData, now, new Date(now));
            assert(result === true, 'T35: Active schedule → true');
        })();

        // T35a: Paused one-off still counts — Stop All should clear it
        (function T35a() {
            const blocklist = createMockBlocklist({ websites: ['paused.com'] });
            const now = Date.now();
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000, {
                isPaused: true,
                pauseEndTime: now + 60000
            });
            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block]
            });
            const result = hasAnyActiveBlocks(appData, now, new Date(now));
            assert(result === true, 'T35a: Paused one-off still active → true');
        })();

        // T35b: Paused schedule still counts — Stop All should clear it
        (function T35b() {
            const blocklist = createMockBlocklist({ websites: ['paused-schedule.com'] });
            const now = Date.now();
            const schedule = createMockSchedule(
                blocklist.id,
                [createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6])],
                { isPaused: true, pauseEndTime: now + 60000 }
            );
            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });
            const result = hasAnyActiveBlocks(appData, now, new Date(now));
            assert(result === true, 'T35b: Paused schedule with future occurrence → true');
        })();

        // T36: Schedule starting later today (not enforcing yet) → true
        (function T36() {
            const blocklist = createMockBlocklist({ websites: ['twitter.com'] });
            const nowDate = new Date();
            nowDate.setHours(12, 0, 0, 0);
            const now = nowDate.getTime();
            const day = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;
            const schedule = createMockSchedule(
                blocklist.id,
                [createMockSegment(18, 0, 22, 0, [day])]
            );
            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });
            const result = hasAnyActiveBlocks(appData, now, nowDate);
            assert(result === true, 'T36: Future schedule today → true');
        })();
    }

    // ========================================
    // CATEGORY 8: findHardestChallenge Advanced
    // ========================================

    function runFindHardestChallengeAdvancedTests() {
        console.log('\n🏋️ Category 8: findHardestChallenge Advanced');
        console.log('----------------------------------------------');

        // T36: Only schedule active (no one-off) — should use schedule's blocklist difficulty
        (function T36() {
            const blocklist = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 80 }
            });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'gibberish', 'T36: Schedule-only → uses schedule difficulty type');
            assertEqual(hardest.count, 80, 'T36: Schedule-only → uses schedule difficulty count');
        })();

        // T37: Mixed active: gibberish 50 vs custom text (long) — custom wins
        (function T37() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 50 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'custom', customText: 'I really need to focus right now and should not be browsing' }
            });
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000)
                ]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'custom', 'T37: Custom text (longer) wins over gibberish');
        })();

        // T38: No active blocks at all → returns default
        (function T38() {
            const now = Date.now();
            const appData = createMockAppData();
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'random-words', 'T38: No blocks → default type');
            assertEqual(hardest.count, 50, 'T38: No blocks → default count 50');
        })();

        // T38b: Inactive schedule should not affect hardest challenge selection
        (function T38b() {
            const blocklist = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 200 }
            });
            const now = Date.now();
            const nowDate = new Date(now);
            const currentDay = nowDate.getDay() === 0 ? 6 : nowDate.getDay() - 1;
            const segment = createMockSegment(0, 0, 1, 0, [currentDay === 0 ? 1 : 0]); // intentionally not active now
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const appData = createMockAppData({
                blocklists: [blocklist],
                schedules: [schedule]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'random-words', 'T38b: Inactive schedule does not override default');
            assertEqual(hardest.count, 50, 'T38b: Inactive schedule does not contribute challenge count');
        })();

        // T38c: Max difficulty (random-words) → effective count 7500
        (function T38c() {
            const blocklist = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', maxDifficulty: true, countBeforeMax: 20 }
            });
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [createMockBlock(blocklist.id, now - 60000, now + 60000)]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'random-words', 'T38c: Max difficulty random-words → type');
            assertEqual(hardest.count, 7500, 'T38c: Max difficulty random-words → effective count 7500');
        })();

        // T38d: Max difficulty (gibberish) → effective count 5000
        (function T38d() {
            const blocklist = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', maxDifficulty: true }
            });
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [createMockBlock(blocklist.id, now - 60000, now + 60000)]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'gibberish', 'T38d: Max difficulty gibberish → type');
            assertEqual(hardest.count, 5000, 'T38d: Max difficulty gibberish → effective count 5000');
        })();

        // T38e: Two active blocks — max difficulty (random-words) wins over fixed count 100
        (function T38e() {
            const blocklist1 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 100 }
            });
            const blocklist2 = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', maxDifficulty: true, countBeforeMax: 50 }
            });
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [
                    createMockBlock(blocklist1.id, now - 60000, now + 60000),
                    createMockBlock(blocklist2.id, now - 60000, now + 60000)
                ]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'random-words', 'T38e: Max difficulty block selected');
            assertEqual(hardest.count, 7500, 'T38e: Max difficulty (7500) wins over 100');
        })();

        // T38f: Paused one-off does not affect hardest challenge selection
        (function T38f() {
            const activeBlocklist = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 80 }
            });
            const pausedBlocklist = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 200 }
            });
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [activeBlocklist, pausedBlocklist],
                activeBlocks: [
                    createMockBlock(activeBlocklist.id, now - 60000, now + 60000),
                    createMockBlock(pausedBlocklist.id, now - 60000, now + 60000, {
                        isPaused: true,
                        pauseEndTime: now + 60000
                    })
                ]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'random-words', 'T38f: Paused one-off ignored for hardest challenge type');
            assertEqual(hardest.count, 80, 'T38f: Paused one-off ignored for hardest challenge count');
        })();

        // T38g: Paused schedule does not affect hardest challenge selection
        (function T38g() {
            const activeBlocklist = createMockBlocklist({
                overrideDifficulty: { type: 'random-words', count: 70 }
            });
            const pausedBlocklist = createMockBlocklist({
                overrideDifficulty: { type: 'gibberish', count: 250 }
            });
            const now = Date.now();
            const appData = createMockAppData({
                blocklists: [activeBlocklist, pausedBlocklist],
                activeBlocks: [createMockBlock(activeBlocklist.id, now - 60000, now + 60000)],
                schedules: [createMockSchedule(
                    pausedBlocklist.id,
                    [createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6])],
                    { isPaused: true, pauseEndTime: now + 60000 }
                )]
            });
            const hardest = findHardestChallengeAtTime(appData, now);
            assertEqual(hardest.type, 'random-words', 'T38g: Paused schedule ignored for hardest challenge type');
            assertEqual(hardest.count, 70, 'T38g: Paused schedule ignored for hardest challenge count');
        })();
    }

    // ========================================
    // CATEGORY 9: Override All State Transitions
    // ========================================

    function runOverrideAllStateTests() {
        console.log('\n💥 Category 9: Override All State Transitions');
        console.log('-----------------------------------------------');

        // T39: One-off + schedule → after override all, no domains blocked
        (function T39() {
            const blocklist1 = createMockBlocklist({ websites: ['facebook.com'] });
            const blocklist2 = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const now = Date.now();

            const appData = createMockAppData({
                blocklists: [blocklist1, blocklist2],
                activeBlocks: [createMockBlock(blocklist1.id, now - 60000, now + 60000)],
                schedules: [createMockSchedule(blocklist2.id, [segment])]
            });

            // Verify blocked before
            let domains = getBlockedDomains(appData, now, new Date(now));
            assertEqual(domains.size, 2, 'T39: Before override → 2 blocked');

            // Perform override all
            simulateOverrideAll(appData);

            domains = getBlockedDomains(appData, now, new Date(now));
            assertSetEmpty(domains, 'T39: After override all → no domains blocked');
        })();

        // T40: Multiple overlapping one-offs → after override, zero active blocks
        (function T40() {
            const bl1 = createMockBlocklist({ websites: ['site1.com'] });
            const bl2 = createMockBlocklist({ websites: ['site2.com'] });
            const bl3 = createMockBlocklist({ websites: ['site3.com'] });
            const now = Date.now();

            const appData = createMockAppData({
                blocklists: [bl1, bl2, bl3],
                activeBlocks: [
                    createMockBlock(bl1.id, now - 60000, now + 60000),
                    createMockBlock(bl2.id, now - 60000, now + 60000),
                    createMockBlock(bl3.id, now - 60000, now + 60000)
                ]
            });

            simulateOverrideAll(appData);
            assertEqual(appData.activeBlocks.length, 0, 'T40: Override all → zero active blocks');
        })();

        // T41: Only schedules → after override, schedules array empty
        (function T41() {
            const bl = createMockBlocklist({ websites: ['youtube.com'] });
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);

            const appData = createMockAppData({
                blocklists: [bl],
                schedules: [
                    createMockSchedule(bl.id, [segment]),
                    createMockSchedule(bl.id, [segment])
                ]
            });

            simulateOverrideAll(appData);
            assertEqual(appData.schedules.length, 0, 'T41: Override all → zero schedules');
        })();

        // T42: Override all preserves blocklists (doesn't delete user's lists)
        (function T42() {
            const bl1 = createMockBlocklist({ name: 'Work Focus' });
            const bl2 = createMockBlocklist({ name: 'Social Media' });
            const now = Date.now();

            const appData = createMockAppData({
                blocklists: [bl1, bl2],
                activeBlocks: [createMockBlock(bl1.id, now - 60000, now + 60000)],
                schedules: [createMockSchedule(bl2.id, [createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6])])]
            });

            simulateOverrideAll(appData);
            assertEqual(appData.blocklists.length, 2, 'T42: Override all preserves blocklists (2 remain)');
            assertEqual(appData.blocklists[0].name, 'Work Focus', 'T42: First blocklist intact');
            assertEqual(appData.blocklists[1].name, 'Social Media', 'T42: Second blocklist intact');
        })();
    }

    // ========================================
    // CATEGORY 12: BLOCKLIST DUPLICATION
    // ========================================

    function runBlocklistDuplicationTests() {
        console.log('\n📋 Category 12: Blocklist Duplication');
        console.log('--------------------------------------');

        const internals = window.__REDDBLOCK_INTERNALS__;
        if (!internals || typeof internals.duplicateBlocklist !== 'function') {
            console.warn('   ⏭️ Duplication tests skipped: duplicateBlocklist not available (run in app with internals)');
            return;
        }

        // Helper: run a duplication test with side-effect isolation.
        // Stubs saveData/render to no-ops so the async fire-and-forget inside
        // duplicateBlocklist doesn't persist mock data or re-render the UI.
        function withIsolatedAppData(mockAppData, fn) {
            const savedAppData = internals.appData;
            const realSave = internals.saveData;
            const realRender = internals.render;
            try {
                internals.saveData = function() {};   // stub: prevent disk writes of mock data
                internals.render = function() {};      // stub: prevent UI re-render with mock data
                internals.appData = mockAppData;
                fn();
            } finally {
                internals.appData = savedAppData;
                internals.saveData = realSave;
                internals.render = realRender;
                internals.saveData();        // persist restored data to disk
                internals.updateHostsFile(); // re-sync helper daemon
                internals.render();          // re-render UI with real data
            }
        }

        /** force settings.language so duplicate suffix is deterministic ('en' default). */
        function duplicationTestAppData(overrides, lang) {
            const mockData = createMockAppData(overrides || {});
            if (!mockData.settings) mockData.settings = {};
            mockData.settings.language = lang === undefined ? 'en' : lang;
            return mockData;
        }

        // T51: Duplicate blocklist
        (function T51() {
            const blocklist = createMockBlocklist({
                name: 'DupTest',
                websites: ['example.com'],
                overrideDifficulty: {
                    type: 'gibberish',
                    count: 40,
                    maxDifficulty: true,
                    countBeforeMax: 40,
                    typeBeforeMax: 'gibberish'
                }
            });
            const mockData = duplicationTestAppData({ blocklists: [blocklist], activeBlocks: [], schedules: [] });
            withIsolatedAppData(mockData, function() {
                internals.duplicateBlocklist(blocklist.id);
                assertEqual(mockData.blocklists.length, 2, 'T51: Two blocklists after duplicate');
                const dup = mockData.blocklists.find(function(bl) { return bl.id !== blocklist.id; });
                assert(dup !== undefined, 'T51: Duplicate blocklist present');
                assert(dup.id !== blocklist.id, 'T51: Duplicate has new id');
                assert(dup.name === 'DupTest copy', 'T51: Name is "DupTest copy"');
                assert(dup.overrideDifficulty && dup.overrideDifficulty.maxDifficulty === true, 'T51: maxDifficulty copied');
                assertEqual(dup.overrideDifficulty.countBeforeMax, 40, 'T51: countBeforeMax copied');
                assertEqual(dup.overrideDifficulty.typeBeforeMax, 'gibberish', 'T51: typeBeforeMax copied');
                assertEqual(dup.overrideDifficulty.type, 'gibberish', 'T51: type copied');
                assertEqual(mockData.activeBlocks.length, 0, 'T51: Duplicate is not in activeBlocks');
            });
        })();

        // T51da: Danish UI uses "kopi" as duplicate suffix
        (function T51da() {
            const blocklist = createMockBlocklist({ name: 'DanskListe', websites: ['x.dk'] });
            const mockData = duplicationTestAppData({ blocklists: [blocklist], activeBlocks: [], schedules: [] }, 'da');
            withIsolatedAppData(mockData, function() {
                internals.duplicateBlocklist(blocklist.id);
                const dup = mockData.blocklists.find(function(bl) { return bl.id !== blocklist.id; });
                assert(dup !== undefined, 'T51da: Duplicate blocklist present');
                assertEqual(dup.name, 'DanskListe kopi', 'T51da: Name uses Danish kopi suffix');
            });
        })();

        // T52: Duplicate copies source schedule as pending draft only (not committed / not enforcing)
        (function T52() {
            const blocklist = createMockBlocklist({ name: 'DupSched', websites: ['a.com'] });
            const now = new Date();
            const inactiveDay = (now.getDay() === 0 ? 6 : now.getDay() - 1) === 0 ? 1 : 0; // Pick a different Mon=0 day
            const segment = createMockSegment(9, 0, 17, 0, [inactiveDay]);
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const mockData = duplicationTestAppData({
                blocklists: [blocklist],
                schedules: [schedule],
                activeBlocks: []
            });
            withIsolatedAppData(mockData, function() {
                internals.duplicateBlocklist(blocklist.id);
                const dup = mockData.blocklists.find(function(bl) { return bl.id !== blocklist.id; });
                assert(dup !== undefined, 'T52: Duplicate blocklist present');
                if (!dup) return;
                const dupSchedule = (mockData.schedules || []).find(function(s) { return s.blocklistId === dup.id; });
                assert(dupSchedule === undefined, 'T52: Duplicate has no committed schedule');
                const pending = mockData.settings.pendingScheduleSegments[dup.id];
                assert(pending && pending.length === 1, 'T52: Pending segments copied for duplicate');
                assertEqual(JSON.stringify(pending[0]), JSON.stringify(segment), 'T52: Segment fields match');
                const repeat = mockData.settings.pendingScheduleRepeatOptions[dup.id];
                assert(repeat && repeat.repeatType === 'forever', 'T52: Repeat options copied as draft');
                assertEqual(mockData.schedules.length, 1, 'T52: Original schedule list unchanged');
            });
        })();

        // T53: Duplicate with active schedule still copies draft only (never auto-enforcing)
        (function T53() {
            const blocklist = createMockBlocklist({ name: 'DupSchedActive', websites: ['active.com'] });
            const now = new Date();
            const currentDayMon0 = now.getDay() === 0 ? 6 : now.getDay() - 1;
            const startHour = now.getHours();
            const endHour = (startHour + 1) % 24;
            const segment = createMockSegment(startHour, 0, endHour, 0, [currentDayMon0]);
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const mockData = duplicationTestAppData({
                blocklists: [blocklist],
                schedules: [schedule],
                activeBlocks: []
            });

            withIsolatedAppData(mockData, function() {
                internals.duplicateBlocklist(blocklist.id);
                const dup = mockData.blocklists.find(function(bl) { return bl.id !== blocklist.id; });
                assert(dup !== undefined, 'T53: Duplicate blocklist present');
                if (!dup) return;
                const dupSchedule = (mockData.schedules || []).find(function(s) { return s.blocklistId === dup.id; });
                assert(dupSchedule === undefined, 'T53: No committed schedule on duplicate');
                const pending = mockData.settings.pendingScheduleSegments[dup.id];
                assert(pending && pending.length === 1, 'T53: Active source schedule copied as pending draft');
                assertEqual(JSON.stringify(pending[0]), JSON.stringify(segment), 'T53: Segment fields match');
                assertEqual(mockData.schedules.length, 1, 'T53: Only original remains committed');
            });
        })();

        // T53b: Duplicate with paused schedule copies draft only (pause does not carry over)
        (function T53b() {
            const blocklist = createMockBlocklist({ name: 'DupSchedPaused', websites: ['pause.com'] });
            const now = new Date();
            const currentDayMon0 = now.getDay() === 0 ? 6 : now.getDay() - 1;
            const startHour = now.getHours();
            const endHour = (startHour + 1) % 24;
            const segment = createMockSegment(startHour, 0, endHour, 0, [currentDayMon0]);
            const schedule = createMockSchedule(blocklist.id, [segment], {
                isPaused: true,
                pauseEndTime: Date.now() + 3600000
            });
            const mockData = duplicationTestAppData({
                blocklists: [blocklist],
                schedules: [schedule],
                activeBlocks: []
            });

            withIsolatedAppData(mockData, function() {
                internals.duplicateBlocklist(blocklist.id);
                const dup = mockData.blocklists.find(function(bl) { return bl.id !== blocklist.id; });
                assert(dup !== undefined, 'T53b: Duplicate blocklist present');
                if (!dup) return;
                const dupSchedule = (mockData.schedules || []).find(function(s) { return s.blocklistId === dup.id; });
                assert(dupSchedule === undefined, 'T53b: No committed schedule on duplicate');
                const pending = mockData.settings.pendingScheduleSegments[dup.id];
                assert(pending && pending.length === 1, 'T53b: Paused source schedule copied as pending draft');
                assertEqual(JSON.stringify(pending[0]), JSON.stringify(segment), 'T53b: Segment fields match');
                assertEqual(mockData.schedules.length, 1, 'T53b: Only original remains committed');
            });
        })();

        // T54: Duplicate naming follows copy chain and gap-fill rules
        (function T54() {
            const original = createMockBlocklist({ name: 'ChainTest', websites: ['example.com'] });
            const firstCopy = createMockBlocklist({ name: 'ChainTest copy', websites: ['example.com'] });
            const thirdCopy = createMockBlocklist({ name: 'ChainTest copy 3', websites: ['example.com'] });
            const mockData = duplicationTestAppData({
                blocklists: [original, firstCopy, thirdCopy],
                activeBlocks: [],
                schedules: []
            });

            withIsolatedAppData(mockData, function() {
                internals.duplicateBlocklist(original.id);
                const dup = mockData.blocklists.find(function(bl) {
                    return bl.id !== original.id && bl.id !== firstCopy.id && bl.id !== thirdCopy.id;
                });
                assert(dup !== undefined, 'T54: Gap-fill duplicate blocklist present');
                if (!dup) return;
                assertEqual(dup.name, 'ChainTest copy 2', 'T54: Duplicate naming fills the missing copy number');
            });
        })();
    }

    // ========================================
    // CATEGORY 10: SELF-BLOCK PREVENTION
    // ========================================

    function runSelfBlockPreventionTests() {
        console.log('\n🛡️ Category 10: Self-Block Prevention');
        console.log('--------------------------------------');

        const { isProtectedApp } = window.__REDDBLOCK_INTERNALS__;

        // T43: "ReDD Blocker" is protected
        (function T43() {
            assert(isProtectedApp('ReDD Blocker'), 'T43: "ReDD Blocker" is protected');
        })();

        // T44: "redd-block" is protected
        (function T44() {
            assert(isProtectedApp('redd-block'), 'T44: "redd-block" is protected');
        })();

        // T45: "redd-block-helper" is protected
        (function T45() {
            assert(isProtectedApp('redd-block-helper'), 'T45: "redd-block-helper" is protected');
        })();

        // T46: Case variations are protected
        (function T46() {
            assert(isProtectedApp('FRISTED'), 'T46: "FRISTED" (legacy name) is protected');
            assert(isProtectedApp('REDD BLOCKER'), 'T46: "REDD BLOCKER" (uppercase) is protected');
            assert(isProtectedApp('  ReDD Blocker  '), 'T46: Leading/trailing spaces handled');
        })();

        // T47: Normal apps are NOT protected
        (function T47() {
            assert(!isProtectedApp('Safari'), 'T47: "Safari" is not protected');
            assert(!isProtectedApp('Chrome'), 'T47: "Chrome" is not protected');
            assert(!isProtectedApp('Slack'), 'T47: "Slack" is not protected');
            assert(!isProtectedApp(''), 'T47: Empty string is not protected');
        })();
    }

    // ========================================
    // CATEGORY 11: PROTECTED DOMAIN PREVENTION
    // ========================================

    function runProtectedDomainTests() {
        console.log('\n🌐 Category 11: Protected Domain Prevention');
        console.log('--------------------------------------------');

        const { isProtectedDomain } = window.__REDDBLOCK_INTERNALS__;

        // T48: Localhost variants are protected
        (function T48() {
            assert(isProtectedDomain('localhost'), 'T48: "localhost" is protected');
            assert(isProtectedDomain('localhost.localdomain'), 'T48: "localhost.localdomain" is protected');
            assert(isProtectedDomain('LOCALHOST'), 'T48: Case-insensitive');
            assert(isProtectedDomain('127.0.0.1'), 'T48: "127.0.0.1" is protected');
            assert(isProtectedDomain('0.0.0.0'), 'T48: "0.0.0.0" is protected');
            assert(isProtectedDomain('::1'), 'T48: "::1" is protected');
        })();

        // T49: App-related domains are protected
        (function T49() {
            assert(isProtectedDomain('broadcasthost'), 'T49: "broadcasthost" is protected');
            assert(isProtectedDomain('local'), 'T49: "local" is protected');
            assert(isProtectedDomain('reddfocus.org'), 'T49: "reddfocus.org" is protected');
            assert(isProtectedDomain('www.reddfocus.org'), 'T49: "www.reddfocus.org" is protected');
            assert(isProtectedDomain('ulyngs.github.io'), 'T49: "ulyngs.github.io" is protected');
        })();

        // T50: Normal domains are NOT protected
        (function T50() {
            assert(!isProtectedDomain('reddit.com'), 'T50: "reddit.com" is not protected');
            assert(!isProtectedDomain('facebook.com'), 'T50: "facebook.com" is not protected');
            assert(!isProtectedDomain('youtube.com'), 'T50: "youtube.com" is not protected');
            assert(!isProtectedDomain(''), 'T50: Empty string is not protected');
        })();
    }

    // ========================================
    // CATEGORY 14: iOS ALLOWLIST POLICY (T55-T62)
    // ========================================

    // Pure-resolver tests for the iOS effective-policy helpers (specific-block
    // vs all-except, blocklist-wins overlap, protected filtering, 50-cap).
    // Sources mirror collectActiveIOSEnforcementSources output: [{ blocklist }].
    function runIOSAllowlistPolicyTests() {
        console.log('\n📱 Category 14: iOS Allowlist Policy');
        console.log('------------------------------------');

        const {
            deriveIOSEffectiveWebsitePolicy,
            deriveIOSEffectiveAppPolicy,
            validateIOSAllowlistLimits,
            IOS_ALLOWLIST_EXCEPTION_LIMIT
        } = window.__REDDBLOCK_INTERNALS__;

        const blockSource = (overrides = {}) => ({
            blocklist: createMockBlocklist({ mode: 'blocklist', ...overrides })
        });
        const allowSource = (overrides = {}) => ({
            blocklist: createMockBlocklist({ mode: 'allowlist', ...overrides })
        });
        const selection = (appTokens, categoryTokens = []) => ({
            applicationTokens: appTokens,
            categoryTokens
        });

        // T55: Block-only sources → specific-block with the blocked union
        (function T55() {
            const policy = deriveIOSEffectiveWebsitePolicy([
                blockSource({ websites: ['reddit.com'] }),
                blockSource({ websites: ['youtube.com'] })
            ]);
            assertEqual(policy.kind, 'specific-block', 'T55: block-only → specific-block');
            assertSetEquals(new Set(policy.domains), ['reddit.com', 'youtube.com'], 'T55: blocked union');
        })();

        // T56: Allow-only source → all-except with the allowed set
        (function T56() {
            const policy = deriveIOSEffectiveWebsitePolicy([
                allowSource({ websites: ['github.com', 'wikipedia.org'] })
            ]);
            assertEqual(policy.kind, 'all-except', 'T56: allow-only → all-except');
            assertSetEquals(new Set(policy.domains), ['github.com', 'wikipedia.org'], 'T56: allowed set');
        })();

        // T57: Two concurrent allowlists union their exceptions
        (function T57() {
            const policy = deriveIOSEffectiveWebsitePolicy([
                allowSource({ websites: ['github.com'] }),
                allowSource({ websites: ['wikipedia.org'] })
            ]);
            assertEqual(policy.kind, 'all-except', 'T57: two allowlists → all-except');
            assertSetEquals(new Set(policy.domains), ['github.com', 'wikipedia.org'], 'T57: exception union');
        })();

        // T58: Blocklist wins on overlap — blocked domain removed from exceptions
        (function T58() {
            const policy = deriveIOSEffectiveWebsitePolicy([
                allowSource({ websites: ['github.com', 'wikipedia.org'] }),
                blockSource({ websites: ['github.com'] })
            ]);
            assertEqual(policy.kind, 'all-except', 'T58: mixed → all-except');
            assertSetEquals(new Set(policy.domains), ['wikipedia.org'], 'T58: blocklist wins on overlap');
        })();

        // T59: Empty exception set stays all-except (block everything), never
        // falls back to blocklist mode; protected domains are filtered out
        (function T59() {
            const policy = deriveIOSEffectiveWebsitePolicy([
                allowSource({ websites: ['github.com'] }),
                blockSource({ websites: ['github.com'] })
            ]);
            assertEqual(policy.kind, 'all-except', 'T59: fully-overlapped allowlist stays all-except');
            assertSetEmpty(new Set(policy.domains), 'T59: empty exception set is legal');

            const protectedPolicy = deriveIOSEffectiveWebsitePolicy([
                allowSource({ websites: ['reddfocus.org', 'github.com'] })
            ]);
            assertSetEquals(new Set(protectedPolicy.domains), ['github.com'], 'T59: protected domains filtered from exceptions');
        })();

        // T60: App policy — allow-only tokens → all-except; categories never
        // ride along as exceptions
        (function T60() {
            const policy = deriveIOSEffectiveAppPolicy([
                allowSource({ iosScreenTimeSelection: selection(['tokA', 'tokB'], ['catX']) })
            ]);
            assertEqual(policy.kind, 'all-except', 'T60: allow tokens → all-except');
            assertSetEquals(new Set(policy.appTokenData), ['tokA', 'tokB'], 'T60: allowed token set');
            assertSetEmpty(new Set(policy.categoryTokenData), 'T60: categories excluded from allow mode');
        })();

        // T61: App policy — blocklist token wins over allowed token; websites-only
        // allowlist leaves the app policy in specific-block (resource independence)
        (function T61() {
            const policy = deriveIOSEffectiveAppPolicy([
                allowSource({ iosScreenTimeSelection: selection(['tokA', 'tokB']) }),
                blockSource({ iosScreenTimeSelection: selection(['tokA'], ['catY']) })
            ]);
            assertEqual(policy.kind, 'all-except', 'T61: mixed app sources → all-except');
            assertSetEquals(new Set(policy.appTokenData), ['tokB'], 'T61: blocked token removed from exceptions');

            const independent = deriveIOSEffectiveAppPolicy([
                allowSource({ websites: ['github.com'] }),
                blockSource({ iosScreenTimeSelection: selection(['tokC'], ['catZ']) })
            ]);
            assertEqual(independent.kind, 'specific-block', 'T61: websites-only allowlist leaves apps in specific-block');
            assertSetEquals(new Set(independent.appTokenData), ['tokC'], 'T61: blocked tokens kept');
            assertSetEquals(new Set(independent.categoryTokenData), ['catZ'], 'T61: blocked categories kept in specific-block');
        })();

        // T62: 50-cap validation — all-except over the cap fails; specific-block
        // never fails (keeps legacy truncation behavior)
        (function T62() {
            const manyDomains = Array.from({ length: IOS_ALLOWLIST_EXCEPTION_LIMIT + 1 }, (_, i) => `site${i}.com`);
            const over = validateIOSAllowlistLimits(
                deriveIOSEffectiveWebsitePolicy([allowSource({ websites: manyDomains })])
            );
            assert(over.ok === false && over.reason === 'domains', 'T62: 51 allowed domains fails validation');
            assertEqual(over.count, IOS_ALLOWLIST_EXCEPTION_LIMIT + 1, 'T62: failure reports the offending count');

            const manyTokens = Array.from({ length: IOS_ALLOWLIST_EXCEPTION_LIMIT + 1 }, (_, i) => `tok${i}`);
            const overTokens = validateIOSAllowlistLimits(
                deriveIOSEffectiveAppPolicy([allowSource({ iosScreenTimeSelection: selection(manyTokens) })])
            );
            assert(overTokens.ok === false && overTokens.reason === 'tokens', 'T62: 51 allowed tokens fails validation');

            const blockOnly = validateIOSAllowlistLimits(
                deriveIOSEffectiveWebsitePolicy([blockSource({ websites: manyDomains })])
            );
            assert(blockOnly.ok === true, 'T62: specific-block policies always pass validation');
        })();
    }

    // ========================================
    // MAIN TEST RUNNER
    // ========================================

    function runAllTests() {
        console.clear();
        console.log('🧪 ReddBlock Blocking Tests');
        console.log('============================');
        console.log(`Running at: ${new Date().toLocaleTimeString()}\n`);

        resetTestResults();

        try {
            runTimeBasedTests();
            runOverlapTests();
            runSharedDomainTests();
            runOverrideTests();
            runAppBlockingTests();
            runOverrideAllTests();
            runHasAnyActiveBlocksTests();
            runFindHardestChallengeAdvancedTests();
            runOverrideAllStateTests();
            runBlocklistDuplicationTests();
            runSelfBlockPreventionTests();
            runProtectedDomainTests();
            runIOSAllowlistPolicyTests();
        } catch (error) {
            console.error('❌ Test suite crashed:', error);
        }

        printTestSummary();
    }

    // Export test runner
    window.ReddBlockTests = {
        runAllTests,
        runTimeBasedTests,
        runOverlapTests,
        runSharedDomainTests,
        runOverrideTests,
        runAppBlockingTests,
        runOverrideAllTests,
        runHasAnyActiveBlocksTests,
        runFindHardestChallengeAdvancedTests,
        runOverrideAllStateTests,
        runBlocklistDuplicationTests,
        runSelfBlockPreventionTests,
        runProtectedDomainTests,
        runIOSAllowlistPolicyTests
    };

    console.log('🧪 ReddBlock Blocking Tests loaded. Press Cmd+Shift+T to run tests.');
})();
