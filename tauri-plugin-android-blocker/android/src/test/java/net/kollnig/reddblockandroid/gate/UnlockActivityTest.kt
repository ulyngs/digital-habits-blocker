package net.kollnig.reddblockandroid.gate

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.WorkManagerTestInitHelper
import net.kollnig.reddblockandroid.data.Schedule
import net.kollnig.reddblockandroid.data.ScheduleTiming
import net.kollnig.reddblockandroid.plugin.R
import net.kollnig.reddblockandroid.schedule.Schedules
import net.kollnig.reddblockandroid.util.PREF_DEFAULT_PAUSE_MINUTES
import net.kollnig.reddblockandroid.util.prefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController

/**
 * Covers the native friction gate — the only thing standing between the user
 * and the app they just asked to be blocked from.
 *
 * The failures that matter here are all one-directional: a gate that unlocks
 * without the challenge being completed, a confirm that does not actually
 * pause, or a gate that appears for a schedule that is not blocking. None of
 * them raise an error; the user just gets through, or gets stuck.
 */
@RunWith(RobolectricTestRunner::class)
class UnlockActivityTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        prefs = context.getSharedPreferences("prefs-test", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        // Schedules.pauseSchedule arms a ReEnableWorker; without a test
        // WorkManager the confirm path throws instead of pausing.
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().build()
        )
    }

    // ---- fixtures ---------------------------------------------------------

    private fun saveSchedule(
        id: String = "s1",
        enabled: Boolean = true,
        wordCount: Int = 3,
        customText: String? = null,
    ): Schedule {
        val schedule = Schedule(
            id = id,
            name = "Deep work",
            isEnabled = enabled,
            timing = ScheduleTiming(type = ScheduleTiming.ScheduleType.MANUAL),
            blockedApps = listOf("com.instagram.android"),
            frictionWordCount = wordCount,
            frictionCustomText = customText,
            emoji = "🎯",
            color = "#ff8800"
        )
        Schedules.save(schedule, context)
        return schedule
    }

    private fun launch(
        scheduleId: String = "s1",
        isWebsite: Boolean = false,
        target: String = "Instagram",
    ): ActivityController<UnlockActivity> {
        val intent = Intent(context, UnlockActivity::class.java).apply {
            putExtra(UnlockActivity.EXTRA_SCHEDULE_ID, scheduleId)
            putExtra(UnlockActivity.EXTRA_SCHEDULE_NAME, "Deep work")
            putExtra(UnlockActivity.EXTRA_BLOCKED_TARGET, target)
            putExtra(UnlockActivity.EXTRA_IS_WEBSITE, isWebsite)
        }
        return Robolectric.buildActivity(UnlockActivity::class.java, intent).create()
    }

    private fun Activity.challengeWords(): List<String> =
        findViewById<TextView>(R.id.gate_challenge_text).text.toString().split(" ")

    private fun Activity.wordInput() = findViewById<EditText>(R.id.gate_word_input)
    private fun Activity.confirmBtn() = findViewById<Button>(R.id.gate_confirm_btn)

    /** Types [count] of the challenge words, or all of them by default. */
    private fun Activity.typeWords(count: Int = Int.MAX_VALUE) {
        val words = challengeWords()
        for (word in words.take(count)) {
            wordInput().setText(word)
        }
    }

    // ---- the gate refuses to appear --------------------------------------

    @Test
    fun `the gate does not appear for an unknown schedule`() {
        val controller = launch(scheduleId = "does-not-exist")
        assertTrue(controller.get().isFinishing)
    }

    @Test
    fun `the gate does not appear for an already-paused schedule`() {
        // A paused schedule is not blocking, so intercepting would be a bug
        // that traps the user behind a gate they already unlocked.
        saveSchedule(enabled = false)
        val controller = launch()
        assertTrue(controller.get().isFinishing)
    }

    @Test
    fun `the gate does not appear without a schedule id`() {
        val intent = Intent(context, UnlockActivity::class.java)
        val controller = Robolectric.buildActivity(UnlockActivity::class.java, intent).create()
        assertTrue(controller.get().isFinishing)
    }

    // ---- the challenge ----------------------------------------------------

    @Test
    fun `a custom-text schedule makes the user type that exact text`() {
        saveSchedule(customText = "  I choose to focus  ")
        val activity = launch().get()
        assertEquals(listOf("I", "choose", "to", "focus"), activity.challengeWords())
    }

    @Test
    fun `a word-count schedule generates that many words`() {
        saveSchedule(wordCount = 7)
        assertEquals(7, launch().get().challengeWords().size)
    }

    @Test
    fun `a nonsensical word count still yields a usable challenge`() {
        // frictionWordCount is clamped: zero would divide by zero when
        // rendering progress, and a huge value would be untypable.
        saveSchedule(wordCount = 0)
        assertTrue(launch().get().challengeWords().isNotEmpty())

        saveSchedule(id = "s2", wordCount = 100_000)
        val words = launch(scheduleId = "s2").get().challengeWords()
        assertTrue(words.isNotEmpty())
        assertTrue(words.size < 1_000)
    }

    @Test
    fun `confirm stays disabled until every word is typed`() {
        saveSchedule(customText = "one two three")
        val activity = launch().get()

        assertFalse("confirm was enabled before the challenge", activity.confirmBtn().isEnabled)

        activity.typeWords(count = 2)
        assertFalse("confirm was enabled part-way through", activity.confirmBtn().isEnabled)

        activity.typeWords()
        assertTrue(activity.confirmBtn().isEnabled)
    }

    @Test
    fun `a wrong word does not advance the challenge`() {
        saveSchedule(customText = "alpha beta")
        val activity = launch().get()

        activity.wordInput().setText("wrong")
        activity.wordInput().setText("alpha")
        activity.wordInput().setText("wrong")
        assertFalse(activity.confirmBtn().isEnabled)

        activity.wordInput().setText("beta")
        assertTrue(activity.confirmBtn().isEnabled)
    }

    @Test
    fun `word matching ignores case and surrounding space`() {
        saveSchedule(customText = "alpha beta")
        val activity = launch().get()

        activity.wordInput().setText("ALPHA")
        activity.wordInput().setText("  Beta  ")
        assertTrue(activity.confirmBtn().isEnabled)
    }

    @Test
    fun `the word input is retired once the challenge is passed`() {
        saveSchedule(customText = "alpha")
        val activity = launch().get()
        activity.typeWords()

        assertFalse(activity.wordInput().isEnabled)
        assertEquals(View.GONE, activity.wordInput().visibility)
    }

    // ---- pausing ----------------------------------------------------------

    @Test
    fun `confirming pauses the schedule for the chosen duration`() {
        saveSchedule(customText = "alpha")
        val activity = launch().get()
        activity.typeWords()

        activity.findViewById<EditText>(R.id.gate_pause_days).setText("0")
        activity.findViewById<EditText>(R.id.gate_pause_hours).setText("1")
        activity.findViewById<EditText>(R.id.gate_pause_minutes).setText("30")

        val before = System.currentTimeMillis()
        activity.confirmBtn().performClick()

        val paused = Schedules.get("s1")
        assertNotNull(paused)
        assertFalse("the schedule was not paused", paused!!.isEnabled)
        val expected = before + 90 * 60_000
        assertTrue(
            "pause expiry ${paused.disabledUntil} is not ~90 minutes out",
            paused.disabledUntil!! >= expected && paused.disabledUntil!! < expected + 60_000
        )
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `confirming does nothing until the challenge is passed`() {
        // The button is disabled in the UI, but the handler must refuse too —
        // otherwise any path that re-enables the button unlocks the gate.
        saveSchedule(customText = "alpha beta")
        val activity = launch().get()
        activity.confirmBtn().isEnabled = true

        activity.confirmBtn().performClick()

        assertTrue("the schedule was paused without the challenge", Schedules.get("s1")!!.isEnabled)
    }

    @Test
    fun `a zero-length pause dismisses without unblocking`() {
        saveSchedule(customText = "alpha")
        val activity = launch().get()
        activity.typeWords()

        for (id in listOf(R.id.gate_pause_days, R.id.gate_pause_hours, R.id.gate_pause_minutes)) {
            activity.findViewById<EditText>(id).setText("0")
        }
        activity.confirmBtn().performClick()

        assertTrue("a zero pause must not unblock", Schedules.get("s1")!!.isEnabled)
        assertTrue(activity.isFinishing)
    }

    @Test
    fun `the pause duration is prefilled from the configured default`() {
        // Mirrors the webview's "Default pause length" setting; a mismatch
        // here means the native gate silently ignores the user's preference.
        prefs.edit().putInt(PREF_DEFAULT_PAUSE_MINUTES, 90).commit()
        saveSchedule()
        val activity = launch().get()

        assertEquals("0", activity.findViewById<EditText>(R.id.gate_pause_days).text.toString())
        assertEquals("1", activity.findViewById<EditText>(R.id.gate_pause_hours).text.toString())
        assertEquals("30", activity.findViewById<EditText>(R.id.gate_pause_minutes).text.toString())
    }

    @Test
    fun `a blank duration field counts as zero rather than crashing`() {
        saveSchedule(customText = "alpha")
        val activity = launch().get()
        activity.typeWords()

        activity.findViewById<EditText>(R.id.gate_pause_days).setText("")
        activity.findViewById<EditText>(R.id.gate_pause_hours).setText("")
        activity.findViewById<EditText>(R.id.gate_pause_minutes).setText("5")
        activity.confirmBtn().performClick()

        assertFalse(Schedules.get("s1")!!.isEnabled)
    }

    // ---- leaving without unlocking ---------------------------------------

    @Test
    fun `backing out of an app block sends the user home`() {
        // Returning to the blocked app would immediately re-trigger the gate.
        saveSchedule()
        val activity = launch(isWebsite = false).get()

        @Suppress("DEPRECATION")
        activity.onBackPressed()

        val next = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_MAIN, next?.action)
        assertTrue(next!!.categories.contains(Intent.CATEGORY_HOME))
        assertTrue(activity.isFinishing)
        assertTrue("backing out must not unblock", Schedules.get("s1")!!.isEnabled)
    }

    @Test
    fun `backing out of a website block just closes the gate`() {
        // The browser was already redirected away, so no home trip is needed.
        saveSchedule()
        val activity = launch(isWebsite = true, target = "reddit.com").get()

        @Suppress("DEPRECATION")
        activity.onBackPressed()

        assertNull(shadowOf(activity).nextStartedActivity)
        assertTrue(activity.isFinishing)
        assertTrue(Schedules.get("s1")!!.isEnabled)
    }

    @Test
    fun `the cancel button leaves without unblocking`() {
        saveSchedule(customText = "alpha")
        val activity = launch(isWebsite = true).get()
        activity.typeWords()

        activity.findViewById<Button>(R.id.gate_cancel_btn).performClick()

        assertTrue("cancel must not unblock", Schedules.get("s1")!!.isEnabled)
        assertTrue(activity.isFinishing)
    }
}
