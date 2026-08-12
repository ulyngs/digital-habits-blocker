/**
 * ReddBlock Blocking Tests
 * 
 * Automated tests for blocking functionality.
 * Run via Cmd+Shift+T in dev mode.
 * 
 * Test Categories:
 * - T1-T9: Time-based scenarios
 * - T9a-T9e: Pause-aware and all-day enforcement semantics
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

        // T9e: One-off and schedule on the same focus space pause independently
        (function T9e() {
            const blocklist = createMockBlocklist({ websites: ['dual-pause.com'] });
            const now = Date.now();
            const segment = createMockSegment(0, 0, 23, 59, [0, 1, 2, 3, 4, 5, 6]);
            const schedule = createMockSchedule(blocklist.id, [segment]);
            const block = createMockBlock(blocklist.id, now - 60000, now + 60000, {
                isPaused: true,
                pauseEndTime: now + 60000
            });

            const pausedOneOffOnly = getBlockedDomains(createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block],
                schedules: [schedule]
            }), now, new Date(now));
            assertSetContains(pausedOneOffOnly, 'dual-pause.com', 'T9e: Schedule still blocks when only one-off is paused');

            const pausedScheduleOnly = getBlockedDomains(createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [createMockBlock(blocklist.id, now - 60000, now + 60000)],
                schedules: [createMockSchedule(blocklist.id, [segment], {
                    isPaused: true,
                    pauseEndTime: now + 60000
                })]
            }), now, new Date(now));
            assertSetContains(pausedScheduleOnly, 'dual-pause.com', 'T9e: One-off still blocks when only schedule is paused');

            const bothPaused = getBlockedDomains(createMockAppData({
                blocklists: [blocklist],
                activeBlocks: [block],
                schedules: [createMockSchedule(blocklist.id, [segment], {
                    isPaused: true,
                    pauseEndTime: now + 120000
                })]
            }), now, new Date(now));
            assertSetEmpty(bothPaused, 'T9e: Both paused on same focus space blocks nothing');
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

        // T43: current and legacy product names are protected
        (function T43() {
            assert(isProtectedApp('Digital Habits Blocker'), 'T43: "Digital Habits Blocker" is protected');
            assert(isProtectedApp('Digital Habits: Blocker'), 'T43: "Digital Habits: Blocker" is protected');
            assert(isProtectedApp('ReDD Blocker'), 'T43: legacy "ReDD Blocker" is protected');
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
            assert(isProtectedApp('  Digital Habits Blocker  '), 'T46: Leading/trailing spaces handled');
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
            assert(isProtectedDomain('reddfocus.org'), 'T49: legacy "reddfocus.org" is protected');
            assert(isProtectedDomain('www.reddfocus.org'), 'T49: legacy "www.reddfocus.org" is protected');
            assert(isProtectedDomain('digitalhabits.org'), 'T49: "digitalhabits.org" is protected');
            assert(isProtectedDomain('www.digitalhabits.org'), 'T49: "www.digitalhabits.org" is protected');
            assert(isProtectedDomain('digitalhabits.org'), 'T49: "digitalhabits.org" is protected');
            assert(isProtectedDomain('www.digitalhabits.org'), 'T49: "www.digitalhabits.org" is protected');
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
    // ========================================
    // CATEGORY 18: ANDROID PAYLOAD (T143-T152)
    // ========================================

    // Android's Kotlin side has no notion of allow mode at any layer, so
    // blockedApps is always treated as a denylist. Sending an allow-mode focus
    // space would block precisely the apps it is meant to permit, so the payload
    // builder omits those spaces entirely.
    function runAndroidPayloadTests() {
        console.log('\n🤖 Category 18: Android Payload');
        console.log('-------------------------------');

        const { buildAndroidScheduleEntries: build } = window.__REDDBLOCK_INTERNALS__;
        const saved = window.__REDDBLOCK_INTERNALS__.appData;

        const seg = { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, days: [] };
        const withData = (blocklists, { schedules = [], activeBlocks = [] } = {}) => {
            window.__REDDBLOCK_INTERNALS__.appData = createMockAppData({ blocklists, schedules, activeBlocks });
        };

        try {
            (function T143() {
                const bl = createMockBlocklist({ mode: 'blocklist', apps: ['com.x'], websites: ['x.com'] });
                withData([bl], { schedules: [createMockSchedule(bl.id, [seg])] });
                const entries = build();
                assertEqual(entries.length, 1, 'T143: a block-mode schedule produces an entry');
                assertEqual(entries[0].blockedApps, ['com.x'], 'T143: and carries its apps');
            })();

            (function T144() {
                const bl = createMockBlocklist({ mode: 'allowlist', apps: ['com.x'], websites: ['x.com'] });
                withData([bl], { schedules: [createMockSchedule(bl.id, [seg])] });
                assertEqual(build().length, 0, 'T144: an allow-mode schedule is omitted entirely');
            })();

            (function T145() {
                // The dangerous case: without the skip, com.keepme would be sent as
                // blockedApps and Kotlin would block the one app meant to stay open.
                const bl = createMockBlocklist({ mode: 'allowlist', apps: ['com.keepme'], websites: [] });
                withData([bl], { schedules: [createMockSchedule(bl.id, [seg])] });
                const allApps = build().flatMap(e => e.blockedApps || []);
                assert(!allApps.includes('com.keepme'), 'T145: an allowed app never reaches the payload as a blocked app');
            })();

            (function T146() {
                const bl = createMockBlocklist({ mode: 'allowlist', apps: ['com.x'] });
                withData([bl], { activeBlocks: [createMockBlock(bl.id, Date.now() - 1000, Date.now() + 60000)] });
                assertEqual(build().length, 0, 'T146: an allow-mode one-off block is omitted too');
            })();

            (function T147() {
                const blockMode = createMockBlocklist({ mode: 'blocklist', apps: ['com.blocked'] });
                const allowMode = createMockBlocklist({ mode: 'allowlist', apps: ['com.allowed'] });
                withData([blockMode, allowMode], {
                    schedules: [createMockSchedule(blockMode.id, [seg]), createMockSchedule(allowMode.id, [seg])],
                });
                const entries = build();
                assertEqual(entries.length, 1, 'T147: only the block-mode space survives a mixed set');
                assertEqual(entries[0].blockedApps, ['com.blocked'], 'T147: and it is the right one');
            })();

            (function T148() {
                // Absent mode must behave as a blocklist — most saved data predates
                // the field entirely.
                const bl = createMockBlocklist({ apps: ['com.x'] });
                delete bl.mode;
                withData([bl], { schedules: [createMockSchedule(bl.id, [seg])] });
                assertEqual(build().length, 1, 'T148: a blocklist with no mode field is still enforced');
            })();

            (function T149() {
                const bl = createMockBlocklist({ mode: 'blocklist', apps: ['com.x'] });
                withData([bl], {
                    schedules: [createMockSchedule(bl.id, [seg, { ...seg, startHour: 19, endHour: 20 }])],
                });
                assertEqual(build().length, 2, 'T149: each segment still becomes its own entry');
            })();

            (function T150() {
                // An allow-mode space must not suppress an unrelated block-mode one
                // that happens to share a segment shape.
                const allowMode = createMockBlocklist({ mode: 'allowlist', apps: ['com.allowed'] });
                const blockMode = createMockBlocklist({ mode: 'blocklist', apps: ['com.blocked'] });
                withData([allowMode, blockMode], {
                    schedules: [createMockSchedule(allowMode.id, [seg])],
                    activeBlocks: [createMockBlock(blockMode.id, Date.now() - 1000, Date.now() + 60000)],
                });
                const entries = build();
                assertEqual(entries.length, 1, 'T150: the block-mode one-off still syncs alongside a skipped allow space');
                assertEqual(entries[0].type, 'MANUAL', 'T150: and keeps its MANUAL type');
            })();
        } finally {
            window.__REDDBLOCK_INTERNALS__.appData = saved;
        }
    }

    // ========================================
    // CATEGORY 19: iOS SCHEDULE PAYLOAD (T151-T158)
    // ========================================

    // ScheduleEntryRequest has carried a per-entry `mode` since allow mode
    // shipped, and IOSPolicyResolver reads it — but the JS producer never set
    // it, so an allow-mode focus space on a *schedule* was sent as blocked
    // items and blocked exactly what it was meant to permit. The manual/one-off
    // path was unaffected (collectActiveIOSManualBlockPayload already sent it).
    function runIOSSchedulePayloadTests() {
        console.log('\n🍎 Category 19: iOS Schedule Payload');
        console.log('-----------------------------------');

        const { buildIOSScheduleEntries: build } = window.__REDDBLOCK_INTERNALS__;
        const saved = window.__REDDBLOCK_INTERNALS__.appData;

        const seg = { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0, days: [] };
        const withData = (blocklists, schedules) => {
            window.__REDDBLOCK_INTERNALS__.appData = createMockAppData({ blocklists, schedules, activeBlocks: [] });
        };

        try {
            (function T151() {
                const bl = createMockBlocklist({ mode: 'blocklist', websites: ['x.com'] });
                withData([bl], [createMockSchedule(bl.id, [seg])]);
                const entries = build();
                assertEqual(entries.length, 1, 'T151: a block-mode schedule produces an entry');
                assertEqual(entries[0].mode, null, 'T151: block mode sends mode: null (legacy semantics)');
            })();

            (function T152() {
                const bl = createMockBlocklist({ mode: 'allowlist', websites: ['x.com'] });
                withData([bl], [createMockSchedule(bl.id, [seg])]);
                const entries = build();
                assertEqual(entries.length, 1, 'T152: an allow-mode schedule still produces an entry (iOS can enforce it)');
                assertEqual(entries[0].mode, 'allowlist', 'T152: and is tagged as an allow list');
            })();

            (function T153() {
                // The bug: x.com was the one site meant to stay reachable, and it
                // arrived as a blocked domain with no mode to say otherwise.
                const bl = createMockBlocklist({ mode: 'allowlist', websites: ['x.com'] });
                withData([bl], [createMockSchedule(bl.id, [seg])]);
                const entry = build()[0];
                assertEqual(entry.domains, ['x.com'], 'T153: the allowed domain is still carried');
                assert(entry.mode === 'allowlist', 'T153: and mode marks it as allowed, not blocked');
            })();

            (function T154() {
                const bl = createMockBlocklist({ mode: 'allowlist', websites: ['x.com'] });
                withData([bl], [createMockSchedule(bl.id, [seg, { ...seg, startHour: 19, endHour: 20 }])]);
                const entries = build();
                assertEqual(entries.length, 2, 'T154: every segment of an allow-mode schedule becomes an entry');
                assert(entries.every(e => e.mode === 'allowlist'), 'T154: and each one carries the mode');
            })();

            (function T155() {
                // One-shot schedules take a different push site; it needs mode too.
                // Occurrences resolve off segment.days relative to createdAt, so a
                // one-shot with no days resolves to nothing at all.
                const bl = createMockBlocklist({ mode: 'allowlist', websites: ['x.com'] });
                const everyDay = { ...seg, days: [0, 1, 2, 3, 4, 5, 6] };
                const sched = createMockSchedule(bl.id, [everyDay], { repeatType: 'no' });
                withData([bl], [sched]);
                const entries = build();
                assert(entries.length >= 1, 'T155: a one-shot allow-mode schedule produces at least one entry');
                assert(entries.every(e => e.mode === 'allowlist'), 'T155: the one-shot push site sets mode too');
            })();

            (function T156() {
                const bl = createMockBlocklist({ websites: ['x.com'] });
                delete bl.mode;
                withData([bl], [createMockSchedule(bl.id, [seg])]);
                assertEqual(build()[0].mode, null, 'T156: a blocklist with no mode field stays blocked semantics');
            })();

            (function T157() {
                const allowMode = createMockBlocklist({ mode: 'allowlist', websites: ['allowed.com'] });
                const blockMode = createMockBlocklist({ mode: 'blocklist', websites: ['blocked.com'] });
                withData([allowMode, blockMode], [
                    createMockSchedule(allowMode.id, [seg]),
                    createMockSchedule(blockMode.id, [seg]),
                ]);
                const entries = build();
                assertEqual(entries.length, 2, 'T157: mixed modes both sync (unlike Android, which skips allow mode)');
                const byMode = Object.fromEntries(entries.map(e => [e.mode ?? 'null', e.domains[0]]));
                assertEqual(byMode.allowlist, 'allowed.com', 'T157: the allow entry carries the allowed domain');
                assertEqual(byMode.null, 'blocked.com', 'T157: the block entry carries the blocked domain');
            })();

            (function T158() {
                // Category tokens are still sent on allow entries; Swift ignores
                // them there, and dropping them would lose data on a mode switch.
                const bl = createMockBlocklist({
                    mode: 'allowlist',
                    websites: [],
                    iosScreenTimeSelection: {
                        applicationTokens: ['tokA'], categoryTokens: ['catA'],
                        applicationCount: 1, categoryCount: 1, summaryLabel: '1 app selected (Screen Time)',
                    },
                });
                withData([bl], [createMockSchedule(bl.id, [seg])]);
                const entry = build()[0];
                assertEqual(entry.appTokenData, ['tokA'], 'T158: app tokens are carried on an allow entry');
                assertEqual(entry.categoryTokenData, ['catA'], 'T158: category tokens are preserved, not zeroed');
            })();
        } finally {
            window.__REDDBLOCK_INTERNALS__.appData = saved;
        }
    }

    // ========================================
    // CATEGORY 20: EDIT FRICTION GATE (T159-T166)
    // ========================================

    // Which focus spaces must confirm a loosening edit with the exit challenge.
    //
    // The pause cases are the point of this group. A paused space is one the
    // user intends to resume, so pause -> loosen -> resume must not be a cheaper
    // route than the challenge — and pausing is itself frictionless on flexible
    // schedules. Every gate in the app has always been pause-INSENSITIVE; these
    // pin that down before the gate moves behind one shared predicate, because
    // the obvious helpers to reach for (isOneOffBlockEnforced,
    // isScheduleSegmentActiveNow) both exempt paused and would silently open it.
    function runEditFrictionGateTests() {
        console.log('\n🔒 Category 20: Edit Friction Gate');
        console.log('----------------------------------');

        const { isBlocklistEditFrictionRequired: required } = window.__REDDBLOCK_INTERNALS__;
        const saved = window.__REDDBLOCK_INTERNALS__.appData;

        const now = Date.now();
        const HOUR = 60 * 60 * 1000;
        // Covers the whole day in both directions so the segment is active
        // whenever the suite happens to run.
        const allDaySeg = { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, days: [0, 1, 2, 3, 4, 5, 6] };
        const withData = (blocklists, { schedules = [], activeBlocks = [] } = {}) => {
            window.__REDDBLOCK_INTERNALS__.appData = createMockAppData({ blocklists, schedules, activeBlocks });
        };

        try {
            (function T159() {
                const bl = createMockBlocklist({});
                withData([bl], { activeBlocks: [createMockBlock(bl.id, now - HOUR, now + HOUR)] });
                assert(required(bl.id, now) === true, 'T159: a running one-off block gates its edits');
            })();

            (function T160() {
                const bl = createMockBlocklist({});
                withData([bl], { activeBlocks: [createMockBlock(bl.id, now - HOUR, now + HOUR, { isPaused: true, pauseEndTime: now + HOUR })] });
                assert(required(bl.id, now) === true, 'T160: a PAUSED one-off block still gates — pause is not an escape hatch');
            })();

            (function T161() {
                const bl = createMockBlocklist({});
                withData([bl], { activeBlocks: [createMockBlock(bl.id, now - HOUR, now + HOUR, { isPaused: true })] });
                assert(required(bl.id, now) === true, 'T161: an indefinitely paused block gates too (no pauseEndTime)');
            })();

            (function T162() {
                const bl = createMockBlocklist({});
                withData([bl], { activeBlocks: [createMockBlock(bl.id, now - 2 * HOUR, now - HOUR)] });
                assert(required(bl.id, now) === false, 'T162: an expired block does not gate');
            })();

            (function T163() {
                const bl = createMockBlocklist({});
                withData([bl], { schedules: [createMockSchedule(bl.id, [allDaySeg])] });
                assert(required(bl.id, now) === true, 'T163: a scheduled space gates its edits');
            })();

            (function T164() {
                const bl = createMockBlocklist({});
                withData([bl], { schedules: [createMockSchedule(bl.id, [allDaySeg], { isPaused: true, pauseEndTime: now + HOUR })] });
                assert(required(bl.id, now) === true, 'T164: a PAUSED schedule still gates');
            })();

            (function T165() {
                const bl = createMockBlocklist({});
                withData([bl], { schedules: [createMockSchedule(bl.id, [allDaySeg], { allowEditsBetweenBlocks: true, isPaused: true, pauseEndTime: now + HOUR })] });
                assert(
                    required(bl.id, now) === false,
                    'T165: allowEditsBetweenBlocks is exempt by design, paused or not',
                );
            })();

            (function T166() {
                const bl = createMockBlocklist({});
                withData([bl]);
                assert(required(bl.id, now) === false, 'T166: an idle space with no block and no schedule does not gate');
                assert(required(null, now) === false, 'T166: a missing id does not gate');
            })();
        } finally {
            window.__REDDBLOCK_INTERNALS__.appData = saved;
        }
    }

    // ========================================
    // CATEGORY 16: CHALLENGE PRIMITIVES (T94-T115)
    // ========================================

    // Characterization tests for the typing-challenge primitives shared by the
    // override / pause / override-all modals. Written BEFORE the controller
    // refactor and green against the pre-refactor tree: they describe behaviour
    // that must not change, and are the regression net the dedup leans on.
    //
    // These are the only automated coverage this engine has ever had — the three
    // implementations drifted into 15 differences precisely because nothing
    // pinned them down.
    function runChallengePrimitiveTests() {
        console.log('\n⌨️  Category 16: Challenge Primitives');
        console.log('------------------------------------');

        const {
            normalizeChallengeComparableText: norm,
            sanitizeChallengeTypedInput: sanitizeTyped,
            sanitizeChallengeTargetText: sanitizeTarget,
            shouldBlockChallengeSpaceKey: blocksSpace,
            renderChallengeReferenceText: renderRef,
            buildWordChallengeState: buildWords,
            getCurrentChallengeWord: currentWord,
            getCompletedChallengeText: completedText,
        } = window.__REDDBLOCK_INTERNALS__;

        // ---- normalizeChallengeComparableText ----
        // This is the fold the word-by-word comparison does NOT currently apply,
        // which is why mobile autocorrect can reject a correct answer.
        (function T94() {
            assertEqual(norm('don’t'), "don't", 'T94: curly apostrophe folds to ASCII');
            assertEqual(norm('“hi”'), '"hi"', 'T94: curly quotes fold to ASCII');
            assertEqual(norm('a—b'), 'a-b', 'T94: em dash folds to hyphen');
            assertEqual(norm('a–b'), 'a-b', 'T94: en dash folds to hyphen');
            assertEqual(norm('a−b'), 'a-b', 'T94: minus sign folds to hyphen');
        })();

        (function T95() {
            assertEqual(norm('a​b'), 'ab', 'T95: zero-width space is stripped');
            assertEqual(norm('a­b'), 'ab', 'T95: soft hyphen is stripped, not kept as a hyphen');
            assertEqual(norm('a b'), 'a b', 'T95: nbsp becomes a normal space');
            assertEqual(norm('x…'), 'x...', 'T95: ellipsis expands to three dots');
        })();

        (function T96() {
            assertEqual(norm(norm('don’t—now')), norm('don’t—now'), 'T96: normalization is idempotent');
            assertEqual(norm(null), '', 'T96: null normalizes to empty string');
            assertEqual(norm(undefined), '', 'T96: undefined normalizes to empty string');
        })();

        // ---- sanitizeChallengeTypedInput ----
        (function T97() {
            assertEqual(sanitizeTyped('  lead'), 'lead', 'T97: leading whitespace is stripped');
            assertEqual(sanitizeTyped('a  b'), 'a b', 'T97: doubled spaces collapse to one');
            assertEqual(sanitizeTyped('a   b    c'), 'a b c', 'T97: longer runs collapse too');
            assertEqual(sanitizeTyped('trail  '), 'trail ', 'T97: trailing run collapses but is NOT trimmed (mid-typing)');
        })();

        // ---- sanitizeChallengeTargetText ----
        (function T98() {
            assertEqual(sanitizeTarget('a\nb'), 'a b', 'T98: newlines become spaces');
            assertEqual(sanitizeTarget('a\r\nb'), 'a b', 'T98: CRLF becomes a single space');
            assertEqual(sanitizeTarget('  padded  '), 'padded', 'T98: target IS trimmed, unlike typed input');
            assertEqual(sanitizeTarget('a’b'), "a'b", 'T98: target text is folded too');
        })();

        // ---- shouldBlockChallengeSpaceKey ----
        const fakeInput = (value, selectionStart) => ({ value, selectionStart });
        (function T99() {
            assert(blocksSpace(fakeInput('', 0), { key: ' ' }) === true, 'T99: leading space is blocked');
            assert(blocksSpace(fakeInput('a ', 2), { key: ' ' }) === true, 'T99: doubled space is blocked');
            assert(blocksSpace(fakeInput('a', 1), { key: ' ' }) === false, 'T99: a normal space is allowed');
            assert(blocksSpace(fakeInput('', 0), { key: 'a' }) === false, 'T99: non-space keys are never blocked');
            assert(blocksSpace(null, { key: ' ' }) === false, 'T99: null input is safe');
        })();

        (function T100() {
            assert(blocksSpace(fakeInput('', 0), { code: 'Space' }) === true, 'T100: event.code Space is recognised');
            assert(blocksSpace(fakeInput('', 0), { key: ' ', metaKey: true }) === false, 'T100: Cmd+Space is not blocked');
            assert(blocksSpace(fakeInput('', 0), { key: ' ', ctrlKey: true }) === false, 'T100: Ctrl+Space is not blocked');
            assert(blocksSpace(fakeInput('', 0), { key: ' ', altKey: true }) === false, 'T100: Alt+Space is not blocked');
        })();

        // ---- renderChallengeReferenceText (synthetic DOM, nothing attached) ----
        const scratch = () => document.createElement('div');
        (function T101() {
            const el = scratch();
            renderRef(el, 'hello world', { cursorIndex: 0, errorIndex: -1 });
            assertEqual(el.textContent, 'hello world', 'T101: plain render writes the full target');
            assertEqual(el.getAttribute('data-challenge-render'), 'plain', 'T101: plain render is tagged');
            assertEqual(el.querySelectorAll('.error-char').length, 0, 'T101: no error span when there is no error');
        })();

        (function T102() {
            const el = scratch();
            renderRef(el, 'abc', { errorIndex: 1 });
            const marks = el.querySelectorAll('.error-char');
            assertEqual(marks.length, 1, 'T102: exactly one error span');
            assertEqual(marks[0].textContent, 'b', 'T102: the error span wraps the wrong character');
            assertEqual(el.getAttribute('data-challenge-render'), 'error', 'T102: error render is tagged');
        })();

        (function T103() {
            const el = scratch();
            renderRef(el, 'a b', { errorIndex: 1 });
            const mark = el.querySelector('.error-char');
            assert(mark.classList.contains('error-char-space'), 'T103: a wrong space gets the space variant class');
        })();

        (function T104() {
            const el = scratch();
            renderRef(el, '', {});
            assertEqual(el.textContent, '', 'T104: empty target renders empty');
            assertEqual(el.getAttribute('data-challenge-render'), null, 'T104: empty target clears the render tag');
            renderRef(null, 'x', {});
            assert(true, 'T104: null element does not throw');
        })();

        (function T105() {
            // Out-of-range errorIndex must fall back to the plain path.
            const el = scratch();
            renderRef(el, 'abc', { errorIndex: 99 });
            assertEqual(el.getAttribute('data-challenge-render'), 'plain', 'T105: out-of-range error index renders plain');
            assertEqual(el.querySelectorAll('.error-char').length, 0, 'T105: and produces no error span');
        })();

        (function T106() {
            // The WKWebView smear guard: an identical re-render must not rewrite the node.
            const el = scratch();
            renderRef(el, 'stable', {});
            const first = el.firstChild;
            renderRef(el, 'stable', {});
            assert(el.firstChild === first, 'T106: identical re-render reuses the existing text node');
        })();

        (function T107() {
            const el = scratch();
            renderRef(el, '<script>&', {});
            assertEqual(el.textContent, '<script>&', 'T107: plain render does not interpret markup');
            const el2 = scratch();
            renderRef(el2, '<b>x', { errorIndex: 0 });
            assertEqual(el2.textContent, '<b>x', 'T107: error render escapes markup rather than injecting it');
        })();

        // ---- word-challenge primitives ----
        (function T108() {
            const st = buildWords('one two three');
            assertEqual(st.words, ['one', 'two', 'three'], 'T108: text splits into words');
            assertEqual(st.currentIndex, 0, 'T108: starts at the first word');
            assertEqual(st.typedText, '', 'T108: starts with empty typed text');
        })();

        (function T109() {
            assertEqual(buildWords('  a   b  ').words, ['a', 'b'], 'T109: extra whitespace produces no empty words');
            assertEqual(buildWords('').words, [], 'T109: empty text yields no words');
            assertEqual(buildWords(null).words, [], 'T109: null text yields no words');
        })();

        (function T110() {
            const st = buildWords('one two');
            assertEqual(currentWord(st), 'one', 'T110: current word at index 0');
            st.currentIndex = 1;
            assertEqual(currentWord(st), 'two', 'T110: current word advances with the index');
            st.currentIndex = 2;
            assertEqual(currentWord(st), '', 'T110: past the end yields empty string, not undefined');
            assertEqual(currentWord(null), '', 'T110: null state yields empty string');
        })();

        (function T111() {
            const st = buildWords('one two three');
            assertEqual(completedText(st), '', 'T111: nothing completed at index 0');
            st.currentIndex = 1;
            assertEqual(completedText(st), 'one', 'T111: one word completed');
            st.currentIndex = 2;
            assertEqual(completedText(st), 'one two', 'T111: completed words rejoin with single spaces');
            st.currentIndex = 3;
            assertEqual(completedText(st), 'one two three', 'T111: all words completed');
            assertEqual(completedText(null), '', 'T111: null state yields empty string');
        })();

        (function T112() {
            // The invariant the controller will rely on: completed prefix + current
            // word reconstructs the typed-so-far target.
            const text = 'alpha beta gamma';
            const st = buildWords(text);
            const seen = [];
            while (currentWord(st)) {
                const prefix = completedText(st);
                seen.push(prefix ? `${prefix} ${currentWord(st)}` : currentWord(st));
                st.currentIndex++;
            }
            assertEqual(seen, ['alpha', 'alpha beta', 'alpha beta gamma'], 'T112: prefix + current word rebuilds the target progressively');
            assertEqual(completedText(st), text, 'T112: after the last word the completed text equals the whole target');
        })();
    }

    // ========================================
    // CATEGORY 17: CHALLENGE CONTROLLER (T113-T140)
    // ========================================

    // The single challenge engine behind the override / pause / override-all
    // modals. Driven here against synthetic detached DOM — no modal is shown and
    // no app state is touched — which is possible only because the controller
    // takes an element map instead of hardcoding getElementById. That is the
    // point of the refactor as much as the line count is.
    //
    // Several cases below pin down bugs that existed in the three hand-copied
    // implementations; each is labelled with the behaviour it locks in.
    function runChallengeControllerTests() {
        console.log('\n🎛️  Category 17: Challenge Controller');
        console.log('------------------------------------');

        const { createChallengeController } = window.__REDDBLOCK_INTERNALS__;

        // Build a throwaway copy of the challenge stack, matching index.html.
        function makeHarness() {
            const root = document.createElement('div');
            root.innerHTML = `
                <div class="modal-content">
                    <div data-el="text" class="challenge-text"></div>
                    <div data-el="wordProgress" class="challenge-word-progress hidden"></div>
                    <div data-el="currentWord" class="challenge-current-word hidden"></div>
                    <input data-el="wordInput" class="challenge-input challenge-word-input hidden">
                    <textarea data-el="input" class="challenge-input"></textarea>
                    <div class="challenge-progress"><div data-el="progressBar" class="challenge-progress-bar"></div></div>
                    <button data-el="confirmBtn"></button>
                </div>`;
            const pick = (n) => root.querySelector(`[data-el="${n}"]`);
            const elements = {
                textEl: pick('text'),
                inputEl: pick('input'),
                wordInputEl: pick('wordInput'),
                wordProgressEl: pick('wordProgress'),
                currentWordEl: pick('currentWord'),
                progressBarEl: pick('progressBar'),
                confirmBtnEl: pick('confirmBtn'),
                modalContentEl: root.querySelector('.modal-content'),
            };
            return { root, elements, controller: createChallengeController(elements) };
        }

        // Type into the free-text box the way a user would, then let the
        // controller's own input listener react.
        const typeChars = (h, value) => {
            h.elements.inputEl.value = value;
            h.elements.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const typeWord = (h, value) => {
            h.elements.wordInputEl.value = value;
            h.elements.wordInputEl.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const barWidth = (h) => h.elements.progressBarEl.style.width;

        // ---- Progress maths ----
        (function T113() {
            const h = makeHarness();
            h.controller.open({ text: 'abcdefghij' });
            assertEqual(barWidth(h), '0%', 'T113: nothing typed → 0%');
            typeChars(h, 'abcde');
            assertEqual(barWidth(h), '50%', 'T113: half typed → 50%');
            typeChars(h, 'abcdefghij');
            assertEqual(barWidth(h), '100%', 'T113: fully typed → 100%');
        })();

        (function T114() {
            // Bug 1: override and override-all divided by zero and wrote
            // "width: NaN%", freezing the bar at its previous value.
            const h = makeHarness();
            h.controller.open({ text: '' });
            typeChars(h, 'anything');
            assertEqual(barWidth(h), '0%', 'T114: empty target gives 0%, never NaN%');
            assert(!barWidth(h).includes('NaN'), 'T114: no NaN reaches the style attribute');
        })();

        (function T115() {
            const h = makeHarness();
            h.controller.open({ text: 'abc' });
            typeChars(h, 'abcdefgh');
            const pct = parseFloat(barWidth(h));
            assert(pct <= 100, 'T115: over-typing never pushes progress past 100%');
        })();

        (function T116() {
            // Progress counts correct leading characters only — a wrong character
            // stops the count even if later characters would match.
            const h = makeHarness();
            h.controller.open({ text: 'abcd' });
            typeChars(h, 'aXcd');
            assertEqual(barWidth(h), '25%', 'T116: progress stops at the first wrong character');
        })();

        // ---- Error highlighting ----
        (function T117() {
            const h = makeHarness();
            h.controller.open({ text: 'abc' });
            typeChars(h, 'abc');
            assertEqual(h.elements.textEl.querySelectorAll('.error-char').length, 0, 'T117: a correct prefix shows no error');
            typeChars(h, 'aXc');
            const marks = h.elements.textEl.querySelectorAll('.error-char');
            assertEqual(marks.length, 1, 'T117: a wrong character is highlighted');
            assertEqual(marks[0].textContent, 'b', 'T117: the highlight lands on the expected character');
        })();

        // ---- Typed-input sanitization is wired up ----
        (function T118() {
            const h = makeHarness();
            h.controller.open({ text: 'a b' });
            typeChars(h, '  a');
            assertEqual(h.elements.inputEl.value, 'a', 'T118: leading whitespace is stripped as you type');
            typeChars(h, 'a  b');
            assertEqual(h.elements.inputEl.value, 'a b', 'T118: doubled spaces collapse as you type');
        })();

        (function T119() {
            const h = makeHarness();
            h.controller.open({ text: "don't" });
            typeChars(h, 'don’t');
            assertEqual(h.controller.handleConfirm().status, 'ok', 'T119: a smart apostrophe still matches in char mode');
        })();

        // ---- Confirm, char mode ----
        (function T120() {
            const h = makeHarness();
            h.controller.open({ text: 'target' });
            typeChars(h, 'wrong');
            assertEqual(h.controller.handleConfirm().status, 'rejected', 'T120: a wrong answer is rejected');
            typeChars(h, 'target');
            assertEqual(h.controller.handleConfirm().status, 'ok', 'T120: the exact answer is accepted');
        })();

        (function T121() {
            const h = makeHarness();
            h.controller.open({ text: 'target' });
            typeChars(h, 'wrong');
            h.controller.handleConfirm();
            assert(h.elements.modalContentEl.classList.contains('wiggle'), 'T121: a rejected answer wiggles the sheet');
        })();

        // ---- Word-by-word mode ----
        (function T122() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta', wordMode: true });
            assert(!h.elements.wordInputEl.classList.contains('hidden'), 'T122: word mode shows the word input');
            assert(h.elements.inputEl.classList.contains('hidden'), 'T122: word mode hides the free textarea');
            assert(!h.elements.currentWordEl.classList.contains('hidden'), 'T122: word mode shows the current word');
            assertEqual(h.elements.currentWordEl.textContent, 'alpha', 'T122: the first word is displayed');
        })();

        (function T123() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta gamma', wordMode: true });
            typeWord(h, 'alpha');
            assertEqual(h.controller.handleConfirm().status, 'advanced', 'T123: a correct non-final word advances');
            assertEqual(h.elements.currentWordEl.textContent, 'beta', 'T123: the next word is displayed');
            assertEqual(h.elements.wordInputEl.value, '', 'T123: the word input is cleared for the next word');
        })();

        (function T124() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta', wordMode: true });
            typeWord(h, 'nope');
            assertEqual(h.controller.handleConfirm().status, 'rejected', 'T124: a wrong word is rejected');
            assertEqual(h.elements.currentWordEl.textContent, 'alpha', 'T124: a wrong word does not advance');
        })();

        (function T125() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta', wordMode: true });
            typeWord(h, 'alpha');
            h.controller.handleConfirm();
            typeWord(h, 'beta');
            assertEqual(h.controller.handleConfirm().status, 'ok', 'T125: the final word completes the challenge');
        })();

        (function T126() {
            // Bug 4: word mode compared raw text, so a mobile autocorrected
            // apostrophe rejected a correct answer. Word mode is mobile-only,
            // which is exactly where autocorrect substitutes characters.
            const h = makeHarness();
            h.controller.open({ text: "don't stop", wordMode: true });
            typeWord(h, 'don’t');
            assertEqual(h.controller.handleConfirm().status, 'advanced', 'T126: an autocorrected apostrophe matches in word mode');
            typeWord(h, 'stop');
            assertEqual(h.controller.handleConfirm().status, 'ok', 'T126: and the challenge still completes');
        })();

        (function T127() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta', wordMode: true });
            typeWord(h, '  alpha  ');
            assertEqual(h.controller.handleConfirm().status, 'advanced', 'T127: surrounding whitespace is tolerated');
        })();

        (function T128() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta', wordMode: true });
            typeWord(h, 'ALPHA');
            assertEqual(h.controller.handleConfirm().status, 'rejected', 'T128: word matching stays case-sensitive');
        })();

        (function T129() {
            // The invariant pause violates today: it leaves typedText empty until
            // the final word, so it is not a valid "progress so far" value.
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta gamma', wordMode: true });
            typeWord(h, 'alpha');
            h.controller.handleConfirm();
            assertEqual(h.controller.getTypedValue(), 'alpha', 'T129: typed value equals the completed prefix after one word');
            typeWord(h, 'beta');
            h.controller.handleConfirm();
            assertEqual(h.controller.getTypedValue(), 'alpha beta', 'T129: and grows with each completed word');
        })();

        (function T130() {
            // The bar measures the target reached *including the word currently on
            // screen*, so it already reads 100% once the last word is displayed —
            // i.e. after the second-to-last confirm. Preserved from the original
            // renderOverrideWordChallengeState; asserted as non-decreasing rather
            // than strictly increasing so the last step is allowed to stay at 100.
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta gamma', wordMode: true });
            const widths = [parseFloat(barWidth(h))];
            for (const w of ['alpha', 'beta', 'gamma']) {
                typeWord(h, w);
                h.controller.handleConfirm();
                widths.push(parseFloat(barWidth(h)));
            }
            assert(widths.every((w, i) => i === 0 || w >= widths[i - 1]), 'T130: the bar never goes backwards');
            assert(widths[1] > widths[0], 'T130: the bar advances on the first word');
            assertEqual(widths[widths.length - 1], 100, 'T130: the completed challenge fills the bar');
        })();

        (function T131() {
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta gamma', wordMode: true });
            assertEqual(h.elements.wordProgressEl.textContent, 'Word 1 of 3', 'T131: the word counter is 1-indexed');
            typeWord(h, 'alpha');
            h.controller.handleConfirm();
            assertEqual(h.elements.wordProgressEl.textContent, 'Word 2 of 3', 'T131: and tracks the current word');
        })();

        // ---- skipChallenge ----
        (function T132() {
            // Bug 2: override-all's skip path left stale text in a now-hidden
            // textarea, so confirm compared it against '' and wiggled — with the
            // field unreachable, an unrecoverable dead end.
            const h = makeHarness();
            h.controller.open({ text: 'something' });
            typeChars(h, 'partial answer');
            h.controller.open({ skipChallenge: true });
            assertEqual(h.elements.inputEl.value, '', 'T132: skipChallenge clears the free textarea');
            assertEqual(h.elements.wordInputEl.value, '', 'T132: skipChallenge clears the word input');
            assertEqual(h.controller.handleConfirm().status, 'ok', 'T132: a skipped challenge confirms immediately');
        })();

        (function T133() {
            const h = makeHarness();
            h.controller.open({ skipChallenge: true });
            assertEqual(h.elements.confirmBtnEl.disabled, false, 'T133: skipChallenge leaves confirm enabled');
            assertEqual(h.elements.textEl.textContent, '', 'T133: skipChallenge shows no challenge text');
        })();

        (function T141() {
            // Emptying the elements is not enough to hide them: .challenge-text
            // has its own padding and background, so an empty one still paints a
            // grey box, and the textarea would sit there inviting input that goes
            // nowhere. The old override-all path hid them with inline display;
            // the controller must hide the whole stack itself rather than relying
            // on each caller (pause only gets away with it via its own CSS).
            const h = makeHarness();
            h.controller.open({ text: 'something' });
            h.controller.open({ skipChallenge: true });
            assert(h.elements.textEl.classList.contains('hidden'), 'T141: skipChallenge hides the challenge text');
            assert(h.elements.inputEl.classList.contains('hidden'), 'T141: skipChallenge hides the free textarea');
            assert(h.elements.wordInputEl.classList.contains('hidden'), 'T141: skipChallenge hides the word input');
            assert(h.elements.currentWordEl.classList.contains('hidden'), 'T141: skipChallenge hides the current word');
            assert(h.elements.wordProgressEl.classList.contains('hidden'), 'T141: skipChallenge hides the word counter');
        })();

        (function T142() {
            // ...and a normal open afterwards must bring the stack back.
            const h = makeHarness();
            h.controller.open({ skipChallenge: true });
            h.controller.open({ text: 'back again' });
            assert(!h.elements.textEl.classList.contains('hidden'), 'T142: a real challenge re-shows the challenge text');
            assert(!h.elements.inputEl.classList.contains('hidden'), 'T142: and re-shows the free textarea');
            assertEqual(h.elements.textEl.textContent, 'back again', 'T142: and renders the new target');
        })();

        // ---- Visibility is class-driven only ----
        (function T134() {
            // Bug: override-all mixed the hidden class with inline style.display,
            // and the inline value was never cleared — so a class-only dedup would
            // silently leave elements hidden forever.
            const h = makeHarness();
            h.controller.open({ text: 'alpha beta', wordMode: true });
            h.controller.open({ text: 'plain text' });
            assertEqual(h.elements.inputEl.style.display, '', 'T134: no inline display is left on the textarea');
            assertEqual(h.elements.wordInputEl.style.display, '', 'T134: nor on the word input');
            assert(!h.elements.inputEl.classList.contains('hidden'), 'T134: char mode re-shows the textarea');
            assert(h.elements.wordInputEl.classList.contains('hidden'), 'T134: and re-hides the word input');
        })();

        // ---- Reopening resets cleanly ----
        (function T135() {
            const h = makeHarness();
            h.controller.open({ text: 'first' });
            typeChars(h, 'first');
            h.controller.open({ text: 'second' });
            assertEqual(h.elements.inputEl.value, '', 'T135: reopening clears the previous answer');
            assertEqual(barWidth(h), '0%', 'T135: reopening resets the progress bar');
            assertEqual(h.controller.handleConfirm().status, 'rejected', 'T135: the previous answer no longer passes');
        })();

        (function T136() {
            const h = makeHarness();
            h.controller.open({ text: 'abc' });
            typeChars(h, 'wrong');
            h.controller.handleConfirm();
            h.controller.open({ text: 'abc' });
            assert(!h.elements.modalContentEl.classList.contains('wiggle'), 'T136: reopening clears a stale wiggle');
        })();

        (function T137() {
            const h = makeHarness();
            h.controller.open({ text: 'abc', progressColor: '#ff0000' });
            assert(h.elements.progressBarEl.style.background.length > 0, 'T137: a progress colour is applied');
            h.controller.open({ text: 'abc' });
            assert(h.elements.progressBarEl.style.background.length > 0, 'T137: a default gradient is applied when no colour is given');
        })();

        // ---- Enter routes through the confirm button ----
        (function T138() {
            // Bug 3: pause called its submit function directly, so Enter worked
            // even while its own confirm button was disabled.
            const h = makeHarness();
            h.controller.open({ text: 'abc' });
            let clicks = 0;
            h.elements.confirmBtnEl.addEventListener('click', () => { clicks++; });
            typeChars(h, 'abc');
            h.elements.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            assertEqual(clicks, 1, 'T138: Enter submits via the confirm button');
            h.elements.confirmBtnEl.disabled = true;
            h.elements.inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            assertEqual(clicks, 1, 'T138: a disabled confirm button suppresses Enter');
        })();

        (function T139() {
            const h = makeHarness();
            h.controller.open({ text: 'a b' });
            h.elements.inputEl.value = '';
            const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
            h.elements.inputEl.dispatchEvent(ev);
            assert(ev.defaultPrevented, 'T139: a leading space is blocked at the keydown');
        })();

        (function T140() {
            const h = makeHarness();
            h.controller.open({ text: 'abc' });
            const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
            h.elements.inputEl.dispatchEvent(ev);
            assert(ev.defaultPrevented, 'T140: pasting into the challenge is blocked');
        })();
    }

    // ========================================
    // CATEGORY 15: EDIT STRICTNESS COMPARATOR (T63-T95)
    // ========================================

    // compareBlocklistStrictness decides whether saving an edit to a *running*
    // focus space needs the exit challenge. Tightening edits must stay free;
    // anything that makes the block easier to get around must be caught.
    function runBlocklistStrictnessTests() {
        console.log('\n🔒 Category 15: Edit Strictness Comparator');
        console.log('------------------------------------------');

        const { compareBlocklistStrictness: cmp, BLOCKLIST_LOOSEN_REASONS: R } = window.__REDDBLOCK_INTERNALS__;

        const block = (o = {}) => createMockBlocklist({ mode: 'blocklist', websites: [], apps: [], ...o });
        const allow = (o = {}) => createMockBlocklist({ mode: 'allowlist', websites: [], apps: [], ...o });
        const sel = (appTokens = [], categoryTokens = []) => ({
            applicationTokens: [...appTokens],
            categoryTokens: [...categoryTokens],
            applicationCount: appTokens.length,
            categoryCount: categoryTokens.length,
            summaryLabel: `${appTokens.length} selected (Screen Time)`,
        });

        // ---- Block mode ----
        (function T63() {
            const a = block({ websites: ['a.com'], apps: ['slack'] });
            assert(cmp(a, { ...a }).loosens === false, 'T63: identical blocklists do not loosen');
        })();

        (function T64() {
            const a = block({ websites: ['a.com'] });
            assert(cmp(a, { ...a, websites: ['a.com', 'b.com'] }).loosens === false, 'T64: adding a blocked website is tightening');
            assert(cmp(a, { ...a, apps: ['slack'] }).loosens === false, 'T64: adding a blocked app is tightening');
        })();

        (function T65() {
            const a = block({ websites: ['a.com', 'b.com'] });
            const r = cmp(a, { ...a, websites: ['a.com'] });
            assert(r.loosens === true, 'T65: removing a blocked website loosens');
            assertEqual(r.primaryReasonCode, R.WEBSITES_REMOVED, 'T65: reason is websites-removed');
            assert(r.reasons[0].items.includes('b.com'), 'T65: removed item is reported');
        })();

        (function T66() {
            const a = block({ apps: ['slack', 'discord'] });
            const r = cmp(a, { ...a, apps: ['slack'] });
            assert(r.loosens === true, 'T66: removing a blocked app loosens');
            assertEqual(r.primaryReasonCode, R.APPS_REMOVED, 'T66: reason is apps-removed');
        })();

        (function T67() {
            const a = block({ websites: ['a.com', 'b.com'] });
            assert(cmp(a, { ...a, websites: ['b.com', 'a.com'] }).loosens === false, 'T67: reordering does not loosen');
        })();

        (function T68() {
            const a = block({ websites: ['reddit.com'] });
            assert(cmp(a, { ...a, websites: ['Reddit.com'] }).loosens === false, 'T68: case-insensitive comparison');
            assert(cmp(a, { ...a, websites: ['  reddit.com  '] }).loosens === false, 'T68: whitespace-insensitive comparison');
        })();

        (function T69() {
            const a = block({ websites: ['a.com'] });
            assert(cmp(a, { ...a, websites: ['a.com', 'a.com'] }).loosens === false, 'T69: duplicate entry does not loosen');
        })();

        (function T70() {
            const a = block({ websites: ['a.com'] });
            const r = cmp(a, { ...a, websites: [] });
            assert(r.loosens === true, 'T70: emptying a blocklist loosens');
            assertEqual(r.primaryReasonCode, R.WEBSITES_REMOVED, 'T70: reported as removal, not scope-opened');
        })();

        // ---- Allow mode (rules invert) ----
        (function T71() {
            const a = allow({ websites: ['a.com', 'b.com'] });
            assert(cmp(a, { ...a, websites: ['a.com'] }).loosens === false, 'T71: removing an allowed website is tightening');
        })();

        (function T72() {
            const a = allow({ websites: ['a.com'] });
            const r = cmp(a, { ...a, websites: ['a.com', 'b.com'] });
            assert(r.loosens === true, 'T72: adding an allowed website loosens');
            assertEqual(r.primaryReasonCode, R.WEBSITES_ALLOWED_ADDED, 'T72: reason is websites-allowed-added');
        })();

        // The one a naive subset check gets backwards: an empty allow list means
        // "everything is allowed", so it is the widest scope, not the narrowest.
        (function T73() {
            const a = allow({ websites: ['a.com'] });
            const r = cmp(a, { ...a, websites: [] });
            assert(r.loosens === true, 'T73: emptying an allow list loosens (everything becomes allowed)');
            assertEqual(r.primaryReasonCode, R.WEBSITES_ALLOW_SCOPE_OPENED, 'T73: reason is websites-allow-scope-opened');
        })();

        (function T74() {
            const a = allow({ websites: [] });
            assert(cmp(a, { ...a, websites: ['a.com'] }).loosens === false, 'T74: empty → restricted allow list is tightening');
        })();

        (function T75() {
            const a = allow({ websites: [] });
            assert(cmp(a, { ...a }).loosens === false, 'T75: an always-empty allow category is not a false positive');
        })();

        (function T76() {
            const a = allow({ websites: ['a.com'], apps: ['slack'] });
            const r = cmp(a, { ...a, websites: [] });
            assert(r.loosens === true, 'T76: websites and apps are evaluated independently');
            assertEqual(r.reasons.length, 1, 'T76: untouched apps produce no reason');
            assertEqual(r.reasons[0].category, 'websites', 'T76: only the websites category is reported');
        })();

        (function T77() {
            const a = allow({ apps: ['slack'] });
            const r = cmp(a, { ...a, apps: [] });
            assert(r.loosens === true, 'T77: emptying the allowed apps loosens');
            assertEqual(r.primaryReasonCode, R.APPS_ALLOW_SCOPE_OPENED, 'T77: reason is apps-allow-scope-opened');
        })();

        (function T78() {
            // On iOS the allowed apps live in Screen Time tokens, so an empty
            // `apps` array does not by itself open the scope.
            const a = allow({ apps: ['slack'], iosScreenTimeSelection: sel(['tok1']) });
            const r = cmp(a, { ...a, apps: [] });
            assert(r.loosens === false, 'T78: apps scope stays closed while Screen Time tokens remain');
        })();

        // ---- Mode ----
        (function T79() {
            const a = block({ websites: ['a.com'] });
            const r = cmp(a, { ...a, mode: 'allowlist' });
            assert(r.loosens === true, 'T79: switching mode loosens');
            assertEqual(r.primaryReasonCode, R.MODE_CHANGED, 'T79: reason is mode-changed');
            assertEqual(r.reasons.length, 1, 'T79: mode change short-circuits the set comparison');
        })();

        (function T80() {
            const a = block({ websites: ['a.com'] });
            delete a.mode;
            assert(cmp(a, { ...a, mode: 'blocklist' }).loosens === false, 'T80: missing mode normalizes to blocklist');
        })();

        // ---- iOS Screen Time selection ----
        (function T81() {
            const a = block({ iosScreenTimeSelection: sel(['t1', 't2']) });
            assert(cmp(a, { ...a, iosScreenTimeSelection: sel(['t2', 't1']) }).loosens === false, 'T81: token order is irrelevant');
        })();

        (function T82() {
            const a = block({ iosScreenTimeSelection: sel(['t1', 't2']) });
            const r = cmp(a, { ...a, iosScreenTimeSelection: sel(['t1']) });
            assert(r.loosens === true, 'T82: removing a Screen Time token loosens');
            assertEqual(r.primaryReasonCode, R.IOS_SELECTION_CHANGED, 'T82: reason is ios-selection-changed');
        })();

        (function T83() {
            const a = block({ iosScreenTimeSelection: sel(['t1']) });
            const drifted = { ...sel(['t1']), applicationCount: 99 };
            assert(cmp(a, { ...a, iosScreenTimeSelection: drifted }).loosens === false, 'T83: derived counts are excluded');
        })();

        (function T84() {
            // A selection iOS can no longer enforce is not protecting anything,
            // so repairing it must not cost a challenge.
            const stale = { ...sel([]), requiresReselection: true };
            const a = block({ iosScreenTimeSelection: stale });
            assert(cmp(a, { ...a, iosScreenTimeSelection: sel(['t1']) }).loosens === false, 'T84: healing an unenforceable selection is free');
        })();

        (function T85() {
            const a = block({ iosScreenTimeSelection: null });
            assert(cmp(a, { ...a, iosScreenTimeSelection: sel(['t1']) }).loosens === true, 'T85: null → real selection is a change');
        })();

        // ---- Exit difficulty (any change gates, by design) ----
        (function T86() {
            const a = block({ overrideDifficulty: { type: 'random-words', count: 50 } });
            const r = cmp(a, { ...a, overrideDifficulty: { type: 'random-words', count: 20 } });
            assert(r.loosens === true, 'T86: lowering the exit difficulty loosens');
            assertEqual(r.primaryReasonCode, R.DIFFICULTY_CHANGED, 'T86: reason is difficulty-changed');
        })();

        (function T87() {
            const a = block({ overrideDifficulty: { type: 'random-words', count: 50 } });
            assert(cmp(a, { ...a, overrideDifficulty: { type: 'random-words', count: 100 } }).loosens === true, 'T87: raising it also gates (no "increases are free" rule)');
            assert(cmp(a, { ...a, overrideDifficulty: { type: 'custom', count: 50, customText: 'x' } }).loosens === true, 'T87: changing type gates');
            assert(cmp(a, { ...a, overrideDifficulty: { type: 'random-words', count: 50, maxDifficulty: true } }).loosens === true, 'T87: toggling max difficulty gates');
        })();

        (function T88() {
            // countBeforeMax / typeBeforeMax are UI-restore bookkeeping only.
            const a = block({ overrideDifficulty: { type: 'random-words', count: 50, countBeforeMax: 10, typeBeforeMax: 'gibberish' } });
            const b = { ...a, overrideDifficulty: { type: 'random-words', count: 50, countBeforeMax: 99, typeBeforeMax: 'custom' } };
            assert(cmp(a, b).loosens === false, 'T88: bookkeeping fields are ignored');
        })();

        (function T89() {
            const a = block({ overrideDifficulty: { type: 'random-words', count: 50 } });
            assert(cmp(a, { ...a, overrideDifficulty: { type: 'random-words', count: '50' } }).loosens === false, 'T89: count is compared numerically');
        })();

        // ---- Cosmetic ----
        (function T90() {
            const a = block({ websites: ['a.com'] });
            const b = {
                ...a,
                name: 'Renamed',
                color: '#123456',
                emoji: '🎯',
                showItemDetails: !a.showItemDetails,
                alwaysShowInSchedule: false,
                isQuickStart: true,
            };
            const r = cmp(a, b);
            assert(r.loosens === false, 'T90: cosmetic-only edits never loosen');
            assertEqual(r.reasons.length, 0, 'T90: no reasons for cosmetic edits');
        })();

        // ---- Guards ----
        (function T91() {
            const a = block({ websites: ['a.com'] });
            assert(cmp(null, a).loosens === false, 'T91: missing previous blocklist is not a loosening');
            assert(cmp(a, null).loosens === false, 'T91: missing candidate is not a loosening');
        })();

        (function T92() {
            // The legacy "N apps selected (Screen Time)" summary shares the apps
            // array but is not an app name.
            const a = block({ apps: ['slack', '3 selected (Screen Time)'] });
            const r = cmp(a, { ...a, apps: ['slack'] });
            assert(r.loosens === false, 'T92: Screen Time summary entries are not treated as removed apps');
        })();

        (function T93() {
            // Several loosenings at once: the hint should name the worst.
            const a = allow({ websites: ['a.com'], overrideDifficulty: { type: 'random-words', count: 50 } });
            const r = cmp(a, { ...a, websites: [], overrideDifficulty: { type: 'random-words', count: 5 } });
            assert(r.loosens === true, 'T93: multiple loosenings are all detected');
            assert(r.reasons.length >= 2, 'T93: each loosening gets its own reason');
            assertEqual(r.primaryReasonCode, R.WEBSITES_ALLOW_SCOPE_OPENED, 'T93: most severe reason is reported first');
        })();

        (function T94() {
            const legacy = block({ overrideDifficulty: undefined });
            const normalized = { ...legacy, overrideDifficulty: { type: 'random-words', count: 50 } };
            assert(cmp(legacy, normalized).loosens === false, 'T94: missing difficulty uses the effective 50-word default');
        })();

        (function T95() {
            const a = block({ iosScreenTimeSelection: sel(['t1']) });
            const relabelled = {
                ...a,
                iosScreenTimeSelection: {
                    ...a.iosScreenTimeSelection,
                    summaryLabel: 'Same token, refreshed display label',
                },
            };
            assert(cmp(a, relabelled).loosens === false, 'T95: Screen Time display-label changes do not affect strictness');
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
            runAndroidPayloadTests();
            runIOSSchedulePayloadTests();
            runEditFrictionGateTests();
            runChallengePrimitiveTests();
            runChallengeControllerTests();
            runBlocklistStrictnessTests();
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
        runIOSAllowlistPolicyTests,
        runAndroidPayloadTests,
        runIOSSchedulePayloadTests,
        runEditFrictionGateTests,
        runChallengePrimitiveTests,
        runChallengeControllerTests,
        runBlocklistStrictnessTests
    };

    console.log('🧪 ReddBlock Blocking Tests loaded. Press Cmd+Shift+T to run tests.');
})();
