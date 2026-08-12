package net.kollnig.reddblockandroid.schedule

import android.content.ContextWrapper
import android.content.SharedPreferences
import net.kollnig.reddblockandroid.data.Schedule
import net.kollnig.reddblockandroid.data.ScheduleTiming
import net.kollnig.reddblockandroid.util.prefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.DayOfWeek
import java.time.LocalTime

/**
 * Covers the decision logic that actually gates the device on Android:
 * which schedule (if any) blocks a package or a domain, and the persistence
 * round-trip those decisions read from.
 *
 * This is a re-implementation of semantics the desktop/JS side derives in
 * `native_host::derive_payload` and covers with Tier 1 — Android shares none
 * of that code, so nothing else keeps the two in step. The characteristic
 * failure here is silence: a schedule that stops matching does not raise an
 * error, blocking just quietly stops for that app or site.
 *
 * [ScheduleManager.scheduleReEnable] needs a real WorkManager, so the pause
 * path is covered through the pure [Schedules.pauseBaseId] /
 * [Schedules.isPauseTarget] pair rather than [Schedules.pauseSchedule].
 */
class SchedulesTest {

    /** Every Schedules entry point that takes a Context ignores it. */
    private val ctx = ContextWrapper(null)

    @Before
    fun resetStore() {
        prefs = FakeSharedPreferences()
    }

    // ---- app blocking -----------------------------------------------------

    @Test
    fun `manual schedule blocks its apps only while a session is active`() {
        val schedule = manual(id = "m1", apps = listOf("com.instagram.android"))
        Schedules.save(schedule, ctx)

        assertFalse(
            "a manual schedule with no session must not block",
            Schedules.isAppBlocked("com.instagram.android")
        )

        Schedules.startSession(ctx, schedule)
        assertEquals("m1", Schedules.findBlockingScheduleForApp("com.instagram.android")?.id)

        Schedules.stopSession(ctx, "m1")
        assertFalse(
            "stopping the session must end the block",
            Schedules.isAppBlocked("com.instagram.android")
        )
    }

    @Test
    fun `a disabled schedule never blocks even with a live session`() {
        // This is what a pause looks like in the store: isEnabled = false with
        // disabledUntil set. The session deliberately survives the pause, so
        // isEnabled is the only thing standing between the user and a block.
        val schedule = manual(id = "m1", apps = listOf("com.instagram.android"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)
        assertTrue(Schedules.isAppBlocked("com.instagram.android"))

        Schedules.save(
            schedule.copy(isEnabled = false, disabledUntil = System.currentTimeMillis() + 600_000),
            ctx
        )
        assertFalse(
            "a paused schedule must not block",
            Schedules.isAppBlocked("com.instagram.android")
        )
    }

    @Test
    fun `a disabled schedule never blocks websites either`() {
        // The app and website lookups filter on isEnabled independently, so
        // the paused-schedule case has to be asserted on both paths.
        val schedule = manual(id = "m1", sites = listOf("reddit.com"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)
        assertTrue(Schedules.isWebsiteBlocked("reddit.com"))

        Schedules.save(
            schedule.copy(isEnabled = false, disabledUntil = System.currentTimeMillis() + 600_000),
            ctx
        )
        assertFalse(
            "a paused schedule must not block websites",
            Schedules.isWebsiteBlocked("reddit.com")
        )
    }

    @Test
    fun `app matching is by exact package name`() {
        val schedule = manual(id = "m1", apps = listOf("com.reddit.frontpage"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)

        assertTrue(Schedules.isAppBlocked("com.reddit.frontpage"))
        // A package that merely shares a prefix is a different app.
        assertFalse(Schedules.isAppBlocked("com.reddit.frontpage.beta"))
        assertFalse(Schedules.isAppBlocked("com.reddit"))
    }

    // ---- website blocking -------------------------------------------------

    @Test
    fun `website matching covers subdomains and normalises stored entries`() {
        // BlockerService.extractDomain hands us a lowercased, www-stripped
        // domain; the stored blocklist entry is whatever the user typed.
        val schedule = manual(id = "m1", sites = listOf("www.Reddit.com"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)

        assertEquals("m1", Schedules.findBlockingScheduleForWebsite("reddit.com")?.id)
        assertEquals("m1", Schedules.findBlockingScheduleForWebsite("old.reddit.com")?.id)
        assertEquals("m1", Schedules.findBlockingScheduleForWebsite("a.b.reddit.com")?.id)
    }

    @Test
    fun `website matching does not fire on lookalike domains`() {
        // A substring match here would block sites the user never listed, and
        // the suffix form is what an attacker-style host would exploit.
        val schedule = manual(id = "m1", sites = listOf("reddit.com"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)

        assertNull(Schedules.findBlockingScheduleForWebsite("notreddit.com"))
        assertNull(Schedules.findBlockingScheduleForWebsite("reddit.com.evil.example"))
        assertNull(Schedules.findBlockingScheduleForWebsite("reddit.co"))
        assertNull(Schedules.findBlockingScheduleForWebsite("example.com"))
    }

    // ---- time windows -----------------------------------------------------

    @Test
    fun `daily schedule blocks inside its window and not outside`() {
        val inside = daily(id = "in", startHoursFromNow = -1, endHoursFromNow = 1)
            .copy(blockedApps = listOf("com.instagram.android"))
        Schedules.save(inside, ctx)
        assertEquals("in", Schedules.findBlockingScheduleForApp("com.instagram.android")?.id)

        resetStore()
        val outside = daily(id = "out", startHoursFromNow = 2, endHoursFromNow = 3)
            .copy(blockedApps = listOf("com.instagram.android"))
        Schedules.save(outside, ctx)
        assertFalse(Schedules.isAppBlocked("com.instagram.android"))
    }

    @Test
    fun `weekly schedule respects its days of week`() {
        val window = daily(id = "w1", startHoursFromNow = -1, endHoursFromNow = 1)
        val everyDay = window.copy(
            blockedApps = listOf("com.instagram.android"),
            timing = window.timing.copy(
                type = ScheduleTiming.ScheduleType.WEEKLY,
                // Every day, so the case holds whichever day the window opened on.
                daysOfWeek = DayOfWeek.entries.toSet()
            )
        )
        Schedules.save(everyDay, ctx)
        assertTrue(Schedules.isAppBlocked("com.instagram.android"))

        resetStore()
        val noDays = everyDay.copy(
            timing = everyDay.timing.copy(daysOfWeek = emptySet())
        )
        Schedules.save(noDays, ctx)
        assertFalse(
            "a weekly schedule with no selected days must never be active",
            Schedules.isAppBlocked("com.instagram.android")
        )
    }

    @Test
    fun `one-shot occurrence window overrides time of day`() {
        val now = System.currentTimeMillis()
        // Time-of-day says "not now"; the absolute window says "now".
        val occurrence = daily(id = "occ", startHoursFromNow = 5, endHoursFromNow = 6).copy(
            blockedApps = listOf("com.instagram.android"),
            activeFromMs = now - 60_000,
            activeUntilMs = now + 60_000
        )
        Schedules.save(occurrence, ctx)
        assertEquals("occ", Schedules.findBlockingScheduleForApp("com.instagram.android")?.id)

        resetStore()
        Schedules.save(
            occurrence.copy(activeFromMs = now - 120_000, activeUntilMs = now - 60_000),
            ctx
        )
        assertFalse(
            "an elapsed occurrence must not block",
            Schedules.isAppBlocked("com.instagram.android")
        )
    }

    // ---- candidate short-circuits ----------------------------------------

    @Test
    fun `blocking candidates reflect enabled schedules with an active session`() {
        // BlockerService uses these to skip work entirely, so a false negative
        // silently disables enforcement for the whole event stream.
        val schedule = manual(
            id = "m1",
            apps = listOf("com.instagram.android"),
            sites = listOf("reddit.com")
        )
        Schedules.save(schedule, ctx)
        assertFalse(Schedules.hasAppBlockingCandidates())
        assertFalse(Schedules.hasWebsiteBlockingCandidates())

        Schedules.startSession(ctx, schedule)
        assertTrue(Schedules.hasAppBlockingCandidates())
        assertTrue(Schedules.hasWebsiteBlockingCandidates())

        Schedules.save(schedule.copy(isEnabled = false), ctx)
        assertFalse(Schedules.hasAppBlockingCandidates())
        assertFalse(Schedules.hasWebsiteBlockingCandidates())
    }

    // ---- pause targeting --------------------------------------------------

    @Test
    fun `pause base id strips the flattened segment suffix`() {
        val uuid = "0189f0c1-2b3d-4e5f-8a9b-0c1d2e3f4a5b"
        assertEquals(36, uuid.length)
        assertEquals(uuid, Schedules.pauseBaseId(uuid))
        assertEquals(uuid, Schedules.pauseBaseId("$uuid-2"))
        assertEquals(uuid, Schedules.pauseBaseId("$uuid-2-7"))
        // Short, non-UUID ids are their own base rather than being truncated.
        assertEquals("legacy-3", Schedules.pauseBaseId("legacy-3"))
    }

    @Test
    fun `pausing targets every enabled entity of the same schedule`() {
        val uuid = "0189f0c1-2b3d-4e5f-8a9b-0c1d2e3f4a5b"
        val other = "99999999-2b3d-4e5f-8a9b-0c1d2e3f4a5b"
        val paused = "$uuid-2"
        val base = Schedules.pauseBaseId(paused)

        assertTrue(Schedules.isPauseTarget(manual(id = paused), paused, base))
        assertTrue(Schedules.isPauseTarget(manual(id = uuid), paused, base))
        assertTrue("sibling segments pause together", Schedules.isPauseTarget(manual(id = "$uuid-5"), paused, base))
        assertTrue(Schedules.isPauseTarget(manual(id = "$uuid-5-1"), paused, base))

        assertFalse("an unrelated schedule must be untouched", Schedules.isPauseTarget(manual(id = other), paused, base))
        assertFalse(
            "an already-disabled entity must not be resurrected by the pause-expiry worker",
            Schedules.isPauseTarget(manual(id = "$uuid-5", enabled = false), paused, base)
        )
    }

    // ---- persistence ------------------------------------------------------

    @Test
    fun `saving a schedule round-trips every field`() {
        val schedule = Schedule(
            id = "s1",
            name = "Deep work",
            isEnabled = true,
            timing = ScheduleTiming(
                type = ScheduleTiming.ScheduleType.WEEKLY,
                timeHour = 9,
                timeMinute = 30,
                endTimeHour = 17,
                endTimeMinute = 45,
                daysOfWeek = setOf(DayOfWeek.MONDAY, DayOfWeek.FRIDAY),
                isRecurring = false
            ),
            blockedApps = listOf("com.instagram.android", "com.reddit.frontpage"),
            blockedWebsites = listOf("reddit.com"),
            frictionWordCount = 7,
            frictionCustomText = "I choose to focus",
            emoji = "🎯",
            color = "#ff8800",
            disabledUntil = 1_700_000_000_000,
            activeFromMs = 1_700_000_000_001,
            activeUntilMs = 1_700_000_000_002
        )
        Schedules.save(schedule, ctx)

        // Re-read through a fresh store so the in-memory cache cannot answer.
        val json = prefs.getString("routines", "[]")
        prefs = FakeSharedPreferences()
        prefs.edit().putString("routines", json).commit()

        assertEquals(schedule, Schedules.get("s1"))
    }

    @Test
    fun `saving a schedule updates the blocked lists of its live session`() {
        val schedule = manual(id = "m1", apps = listOf("com.instagram.android"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)

        Schedules.save(schedule.copy(blockedApps = listOf("com.reddit.frontpage")), ctx)

        val session = Schedules.getActiveSessions().single { it.scheduleId == "m1" }
        assertEquals(setOf("com.reddit.frontpage"), session.blockedApps)
        assertTrue(Schedules.isAppBlocked("com.reddit.frontpage"))
        assertFalse(Schedules.isAppBlocked("com.instagram.android"))
    }

    @Test
    fun `deleting a schedule also ends its session`() {
        val schedule = manual(id = "m1", apps = listOf("com.instagram.android"))
        Schedules.save(schedule, ctx)
        Schedules.startSession(ctx, schedule)

        Schedules.delete("m1", ctx)

        assertTrue(Schedules.getAll().isEmpty())
        assertTrue(Schedules.getActiveSessions().none { it.scheduleId == "m1" })
        assertFalse(Schedules.isAppBlocked("com.instagram.android"))
    }

    @Test
    fun `active sessions still parse the legacy routineId key`() {
        // Sessions written by an older build key the id as "routineId".
        prefs.edit().putString(
            "active_routine_sessions",
            """[{"routineId":"m1","startTime":1700000000000,"blockedApps":["com.instagram.android"],"blockedWebsites":[]}]"""
        ).commit()
        Schedules.save(manual(id = "m1", apps = listOf("com.instagram.android")), ctx)

        assertEquals("m1", Schedules.getActiveSessions().single().scheduleId)
        assertTrue(Schedules.isAppBlocked("com.instagram.android"))
    }

    @Test
    fun `corrupt stored data yields no schedules instead of throwing`() {
        prefs.edit().putString("routines", "{not json").commit()
        assertTrue(Schedules.getAll().isEmpty())
        assertFalse(Schedules.isAppBlocked("com.instagram.android"))

        // A well-formed array with an unusable entry keeps the good entries.
        resetStore()
        prefs.edit().putString(
            "routines",
            """[{"id":"broken"},{"id":"ok","name":"Ok","isEnabled":true,"schedule":{"type":"MANUAL"}}]"""
        ).commit()
        assertEquals(listOf("ok"), Schedules.getAll().map { it.id })
    }

    @Test
    fun `createDefaults does not overwrite existing schedules`() {
        Schedules.save(manual(id = "m1"), ctx)
        Schedules.createDefaults(ctx)
        assertEquals(listOf("m1"), Schedules.getAll().map { it.id })
    }

    // ---- helpers ----------------------------------------------------------

    private fun manual(
        id: String,
        enabled: Boolean = true,
        apps: List<String> = emptyList(),
        sites: List<String> = emptyList()
    ) = Schedule(
        id = id,
        name = "Schedule $id",
        isEnabled = enabled,
        timing = ScheduleTiming(type = ScheduleTiming.ScheduleType.MANUAL),
        blockedApps = apps,
        blockedWebsites = sites
    )

    /**
     * A DAILY schedule whose window sits [startHoursFromNow]..[endHoursFromNow]
     * around the current wall clock, so the case holds whatever time CI runs at.
     */
    private fun daily(id: String, startHoursFromNow: Long, endHoursFromNow: Long): Schedule {
        val now = LocalTime.now()
        val start = now.plusHours(startHoursFromNow)
        val end = now.plusHours(endHoursFromNow)
        return Schedule(
            id = id,
            name = "Schedule $id",
            timing = ScheduleTiming(
                type = ScheduleTiming.ScheduleType.DAILY,
                timeHour = start.hour,
                timeMinute = start.minute,
                endTimeHour = end.hour,
                endTimeMinute = end.minute
            )
        )
    }
}

/** In-memory [SharedPreferences]; the JVM test JVM has no Android storage. */
private class FakeSharedPreferences : SharedPreferences {
    private val values = mutableMapOf<String, Any?>()

    override fun getAll(): MutableMap<String, *> = values.toMutableMap()

    override fun getString(key: String?, defValue: String?): String? =
        values[key] as? String ?: defValue

    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
        values[key] as? MutableSet<String> ?: defValues

    override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue

    override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue

    override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue

    override fun getBoolean(key: String?, defValue: Boolean): Boolean =
        values[key] as? Boolean ?: defValue

    override fun contains(key: String?): Boolean = values.containsKey(key)

    override fun edit(): SharedPreferences.Editor = FakeEditor(values)

    override fun registerOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?
    ) = Unit

    override fun unregisterOnSharedPreferenceChangeListener(
        listener: SharedPreferences.OnSharedPreferenceChangeListener?
    ) = Unit
}

private class FakeEditor(private val target: MutableMap<String, Any?>) : SharedPreferences.Editor {
    private val staged = mutableMapOf<String, Any?>()
    private val removed = mutableSetOf<String>()
    private var cleared = false

    private fun stage(key: String?, value: Any?): SharedPreferences.Editor {
        if (key != null) staged[key] = value
        return this
    }

    override fun putString(key: String?, value: String?) = stage(key, value)
    override fun putStringSet(key: String?, values: MutableSet<String>?) = stage(key, values)
    override fun putInt(key: String?, value: Int) = stage(key, value)
    override fun putLong(key: String?, value: Long) = stage(key, value)
    override fun putFloat(key: String?, value: Float) = stage(key, value)
    override fun putBoolean(key: String?, value: Boolean) = stage(key, value)

    override fun remove(key: String?): SharedPreferences.Editor {
        if (key != null) removed.add(key)
        return this
    }

    override fun clear(): SharedPreferences.Editor {
        cleared = true
        return this
    }

    override fun commit(): Boolean {
        if (cleared) target.clear()
        removed.forEach { target.remove(it) }
        target.putAll(staged)
        staged.clear()
        removed.clear()
        cleared = false
        return true
    }

    override fun apply() {
        commit()
    }
}
