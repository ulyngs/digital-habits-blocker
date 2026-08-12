package net.kollnig.reddblockandroid.service

import android.app.KeyguardManager
import android.content.Context
import android.view.accessibility.AccessibilityEvent
import androidx.test.core.app.ApplicationProvider
import net.kollnig.reddblockandroid.data.Schedule
import net.kollnig.reddblockandroid.data.ScheduleTiming
import net.kollnig.reddblockandroid.gate.UnlockActivity
import net.kollnig.reddblockandroid.schedule.Schedules
import net.kollnig.reddblockandroid.util.prefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/**
 * Covers the accessibility service's app-blocking decision path end to end:
 * an event arrives, and either the native friction gate is launched with the
 * right payload or nothing happens at all.
 *
 * Both failure directions are silent in production — a gate that never
 * launches looks like "blocking is off", and one that launches for the wrong
 * app interrupts the user with no error anywhere.
 *
 * Not covered here: the website path, which reads the browser accessibility
 * tree through `rootInActiveWindow`. Robolectric cannot populate that for an
 * AccessibilityService; the parsing half of it is covered by
 * [BrowserUrlParserTest] and the end-to-end half by the manual checklist.
 */
@RunWith(RobolectricTestRunner::class)
class BlockerServiceTest {

    private lateinit var service: BlockerService

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        prefs = context.getSharedPreferences("prefs-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        service = Robolectric.buildService(BlockerService::class.java).create().get()
    }

    private fun windowEvent(pkg: String): AccessibilityEvent {
        @Suppress("DEPRECATION")
        val event = AccessibilityEvent.obtain()
        event.eventType = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        event.packageName = pkg
        return event
    }

    private fun blockNow(pkg: String, id: String = "m1", name: String = "Focus"): Schedule {
        val schedule = Schedule(
            id = id,
            name = name,
            isEnabled = true,
            timing = ScheduleTiming(type = ScheduleTiming.ScheduleType.MANUAL),
            blockedApps = listOf(pkg)
        )
        Schedules.save(schedule, service)
        Schedules.startSession(service, schedule)
        return schedule
    }

    private fun keyguard() =
        shadowOf(service.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager)

    // ---- the gate launches ------------------------------------------------

    @Test
    fun `opening a blocked app launches the friction gate with the block details`() {
        blockNow("com.instagram.android", id = "m1", name = "Social Media")

        service.onAccessibilityEvent(windowEvent("com.instagram.android"))

        val started = shadowOf(service).nextStartedActivity
        assertEquals(
            UnlockActivity::class.java.name,
            started?.component?.className
        )
        assertEquals("m1", started?.getStringExtra(UnlockActivity.EXTRA_SCHEDULE_ID))
        assertEquals("Social Media", started?.getStringExtra(UnlockActivity.EXTRA_SCHEDULE_NAME))
        // App blocks report the app, not a domain, and must not take the
        // website dismissal path in the gate.
        assertEquals(false, started?.getBooleanExtra(UnlockActivity.EXTRA_IS_WEBSITE, true))
    }

    @Test
    fun `the gate is launched into its own task`() {
        // Without NEW_TASK the gate cannot be started from a service context
        // at all, and the block silently never appears.
        blockNow("com.instagram.android")
        service.onAccessibilityEvent(windowEvent("com.instagram.android"))

        val flags = shadowOf(service).nextStartedActivity?.flags ?: 0
        assertTrue(flags and android.content.Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertTrue(flags and android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
    }

    // ---- the gate stays away ---------------------------------------------

    @Test
    fun `an unblocked app is left alone`() {
        blockNow("com.instagram.android")
        service.onAccessibilityEvent(windowEvent("com.example.notes"))
        assertNull(shadowOf(service).nextStartedActivity)
    }

    @Test
    fun `nothing is blocked when no schedule has a session`() {
        // Saved but never started: the app is on a blocklist that is not
        // currently blocking.
        Schedules.save(
            Schedule(
                id = "m1",
                name = "Focus",
                timing = ScheduleTiming(type = ScheduleTiming.ScheduleType.MANUAL),
                blockedApps = listOf("com.instagram.android")
            ),
            service
        )
        service.onAccessibilityEvent(windowEvent("com.instagram.android"))
        assertNull(shadowOf(service).nextStartedActivity)
    }

    @Test
    fun `a paused schedule does not launch the gate`() {
        val schedule = blockNow("com.instagram.android")
        Schedules.save(
            schedule.copy(isEnabled = false, disabledUntil = System.currentTimeMillis() + 600_000),
            service
        )
        service.onAccessibilityEvent(windowEvent("com.instagram.android"))
        assertNull(shadowOf(service).nextStartedActivity)
    }

    @Test
    fun `the gate never interrupts a locked screen`() {
        // Waking to a lock screen would otherwise pop the gate over it.
        blockNow("com.instagram.android")
        keyguard().setKeyguardLocked(true)

        service.onAccessibilityEvent(windowEvent("com.instagram.android"))

        assertNull(shadowOf(service).nextStartedActivity)
    }

    @Test
    fun `the blocker never blocks itself`() {
        // Its own package reaching the gate would make the app unusable.
        blockNow(service.packageName)
        service.onAccessibilityEvent(windowEvent(service.packageName))
        assertNull(shadowOf(service).nextStartedActivity)
    }

    @Test
    fun `irrelevant event types are ignored`() {
        blockNow("com.instagram.android")
        @Suppress("DEPRECATION")
        val event = AccessibilityEvent.obtain()
        event.eventType = AccessibilityEvent.TYPE_VIEW_CLICKED
        event.packageName = "com.instagram.android"

        service.onAccessibilityEvent(event)

        assertNull(shadowOf(service).nextStartedActivity)
    }

    // ---- throttling -------------------------------------------------------

    @Test
    fun `repeat events for the same app do not relaunch the gate`() {
        // Apps emit window-state events continuously; one gate per block is
        // the point, a stream of them is unusable.
        blockNow("com.instagram.android")

        service.onAccessibilityEvent(windowEvent("com.instagram.android"))
        assertTrue(shadowOf(service).nextStartedActivity != null)

        service.onAccessibilityEvent(windowEvent("com.instagram.android"))
        service.onAccessibilityEvent(windowEvent("com.instagram.android"))
        assertNull(
            "the gate relaunched inside the throttle window",
            shadowOf(service).nextStartedActivity
        )
    }

    @Test
    fun `switching to a different blocked app launches its own gate`() {
        // The throttle is per package — a second blocked app opened right
        // after the first must still be intercepted.
        blockNow("com.instagram.android", id = "m1", name = "Social")
        val second = Schedule(
            id = "m2",
            name = "Video",
            timing = ScheduleTiming(type = ScheduleTiming.ScheduleType.MANUAL),
            blockedApps = listOf("com.google.android.youtube")
        )
        Schedules.save(second, service)
        Schedules.startSession(service, second)

        service.onAccessibilityEvent(windowEvent("com.instagram.android"))
        assertEquals("m1", shadowOf(service).nextStartedActivity?.getStringExtra(UnlockActivity.EXTRA_SCHEDULE_ID))

        service.onAccessibilityEvent(windowEvent("com.google.android.youtube"))
        assertEquals("m2", shadowOf(service).nextStartedActivity?.getStringExtra(UnlockActivity.EXTRA_SCHEDULE_ID))
    }
}
