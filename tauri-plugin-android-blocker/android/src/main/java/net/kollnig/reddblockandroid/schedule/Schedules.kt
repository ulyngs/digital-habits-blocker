package net.kollnig.reddblockandroid.schedule

import android.content.Context
import android.util.Log
import androidx.core.content.edit
import net.kollnig.reddblockandroid.data.Schedule
import net.kollnig.reddblockandroid.data.ScheduleTiming
import net.kollnig.reddblockandroid.util.prefs
import org.json.JSONArray
import org.json.JSONObject
import java.time.DayOfWeek
import java.util.UUID

/**
 * Single, simple schedule system. Supports MULTIPLE active schedules simultaneously.
 *
 * For MANUAL schedules, an explicit session is stored in SharedPreferences so
 * blocking persists until the user toggles it off.
 *
 * For DAILY/WEEKLY schedules, blocking is evaluated in real-time by checking
 * whether the current time falls within the schedule's time window. No
 * WorkManager activation/deactivation workers are needed — the accessibility
 * service checks the time on every event.
 */
object Schedules {
    private const val TAG = "Schedules"
    private const val SCHEDULES_KEY = "routines" // keep legacy key for data compat
    private const val ACTIVE_SESSIONS_KEY = "active_routine_sessions" // keep legacy key

    data class ActiveSession(
        val scheduleId: String,
        val startTime: Long,
        val blockedApps: Set<String>,
        val blockedWebsites: Set<String>
    )

    fun getAll(): List<Schedule> {
        val json = prefs.getString(SCHEDULES_KEY, "[]") ?: "[]"
        return try {
            JSONArray(json).let { arr ->
                (0 until arr.length()).mapNotNull { parseSchedule(arr.getJSONObject(it)) }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun exportSchedules(): String {
        val schedules = getAll()
        val json = JSONArray().apply {
            schedules.forEach { put(scheduleToJson(it)) }
        }
        return json.toString(2)
    }

    fun importSchedules(jsonString: String, context: Context): Int {
        return try {
            val arr = JSONArray(jsonString)
            var count = 0
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val schedule = parseSchedule(obj)
                if (schedule != null) {
                    val newSchedule = schedule.copy(id = UUID.randomUUID().toString())
                    save(newSchedule, context)
                    count++

                    // For manual schedules, start a session immediately if enabled
                    if (newSchedule.isEnabled && newSchedule.timing.type == ScheduleTiming.ScheduleType.MANUAL) {
                        startSession(context, newSchedule)
                    }
                }
            }
            count
        } catch (e: Exception) {
            Log.e(TAG, "Failed to import schedules", e)
            -1
        }
    }

    fun get(id: String): Schedule? = getAll().find { it.id == id }

    fun save(schedule: Schedule, context: Context) {
        val schedules = getAll().toMutableList()
        val index = schedules.indexOfFirst { it.id == schedule.id }

        if (index >= 0) schedules[index] = schedule
        else schedules.add(schedule)

        saveAll(schedules)

        // If this is a manual schedule with an active session, update its blocked lists
        val sessions = getActiveSessions().toMutableList()
        val sessionIndex = sessions.indexOfFirst { it.scheduleId == schedule.id }
        if (sessionIndex >= 0) {
            sessions[sessionIndex] = sessions[sessionIndex].copy(
                blockedApps = schedule.blockedApps.toSet(),
                blockedWebsites = schedule.blockedWebsites.toSet()
            )
            saveActiveSessions(sessions)
        }
    }

    fun delete(id: String, context: Context) {
        stopSession(context, id)
        val schedules = getAll().filterNot { it.id == id }
        saveAll(schedules)
    }

    /**
     * Toggle a schedule on or off permanently. When turning OFF, clears any
     * pending auto re-enable — the schedule stays disabled until the user
     * explicitly turns it back on. Temporary unlocks from the block friction
     * gate use [temporaryUnlock] instead.
     */
    fun toggle(id: String, context: Context) {
        Log.d(TAG, "Toggle called for schedule ID: $id")

        val schedule = get(id) ?: run {
            Log.e(TAG, "Schedule not found: $id")
            return
        }

        if (schedule.isEnabled) {
            // Turning OFF permanently
            val updated = schedule.copy(isEnabled = false, disabledUntil = null)

            val schedules = getAll().toMutableList()
            val index = schedules.indexOfFirst { it.id == id }
            if (index >= 0) schedules[index] = updated
            saveAll(schedules)

            // Stop manual session if one exists and cancel any pending re-enable
            stopSession(context, id)
            ScheduleManager.cancelSchedule(context, id)
        } else {
            // Turning ON (re-enabling)
            val updated = schedule.copy(isEnabled = true, disabledUntil = null)

            val schedules = getAll().toMutableList()
            val index = schedules.indexOfFirst { it.id == id }
            if (index >= 0) schedules[index] = updated
            saveAll(schedules)

            // Cancel any pending auto re-enable — we've enabled it now
            ScheduleManager.cancelSchedule(context, id)

            // Only manual schedules need an explicit session
            if (updated.timing.type == ScheduleTiming.ScheduleType.MANUAL) {
                startSession(context, updated)
            }
        }
    }

    /**
     * Temporarily unlock a schedule after the user passes the friction gate on
     * the block screen. Disables blocking for the schedule's configured
     * [Schedule.autoReenableMinutes] and schedules an automatic re-enable.
     * If `autoReenableMinutes` is 0, the schedule stays disabled until the
     * user turns it back on.
     */
    fun temporaryUnlock(context: Context, id: String) {
        Log.d(TAG, "Temporary unlock for schedule ID: $id")

        val schedule = get(id) ?: run {
            Log.e(TAG, "Schedule not found: $id")
            return
        }
        if (!schedule.isEnabled) return

        val updated = if (schedule.autoReenableMinutes > 0) {
            val disabledUntil = System.currentTimeMillis() + schedule.autoReenableMinutes * 60_000L
            schedule.copy(isEnabled = false, disabledUntil = disabledUntil)
        } else {
            schedule.copy(isEnabled = false, disabledUntil = null)
        }

        val schedules = getAll().toMutableList()
        val index = schedules.indexOfFirst { it.id == id }
        if (index >= 0) schedules[index] = updated
        saveAll(schedules)

        stopSession(context, id)
        ScheduleManager.cancelSchedule(context, id)

        if (schedule.autoReenableMinutes > 0) {
            ScheduleManager.scheduleReEnable(context, id, schedule.autoReenableMinutes * 60_000L)
        }
    }

    fun reEnableSchedule(context: Context, scheduleId: String) {
        Log.d(TAG, "Auto-re-enabling schedule: $scheduleId")
        val schedule = get(scheduleId) ?: return
        if (schedule.isEnabled) return // already enabled

        val updated = schedule.copy(isEnabled = true, disabledUntil = null)
        val schedules = getAll().toMutableList()
        val index = schedules.indexOfFirst { it.id == scheduleId }
        if (index >= 0) schedules[index] = updated
        saveAll(schedules)

        // Only manual schedules need an explicit session
        if (updated.timing.type == ScheduleTiming.ScheduleType.MANUAL) {
            startSession(context, updated)
        }
    }

    private fun saveAll(schedules: List<Schedule>) {
        val json = JSONArray().apply {
            schedules.forEach { put(scheduleToJson(it)) }
        }
        prefs.edit { putString(SCHEDULES_KEY, json.toString()) }
    }

    fun startSession(context: Context, schedule: Schedule) {
        Log.d(TAG, "Starting session for: ${schedule.name}")

        val sessions = getActiveSessions().toMutableList()
        sessions.removeAll { it.scheduleId == schedule.id }

        val newSession = ActiveSession(
            scheduleId = schedule.id,
            startTime = System.currentTimeMillis(),
            blockedApps = schedule.blockedApps.toSet(),
            blockedWebsites = schedule.blockedWebsites.toSet()
        )
        sessions.add(newSession)
        saveActiveSessions(sessions)

        Log.d(TAG, "Started session for ${schedule.name} with ${schedule.blockedApps.size} blocked apps and ${schedule.blockedWebsites.size} blocked websites")
    }

    fun stopSession(context: Context, scheduleId: String) {
        Log.d(TAG, "Stopping session for schedule: $scheduleId")

        val sessions = getActiveSessions().toMutableList()
        val removed = sessions.removeAll { it.scheduleId == scheduleId }

        if (removed) {
            saveActiveSessions(sessions)
        }
    }

    fun getActiveSessions(): List<ActiveSession> {
        val json = prefs.getString(ACTIVE_SESSIONS_KEY, "[]") ?: "[]"
        return try {
            JSONArray(json).let { arr ->
                (0 until arr.length()).mapNotNull {
                    try {
                        val obj = arr.getJSONObject(it)

                        val blockedApps = mutableSetOf<String>()
                        obj.optJSONArray("blockedApps")?.let { appsArr ->
                            for (i in 0 until appsArr.length()) {
                                blockedApps.add(appsArr.getString(i))
                            }
                        }

                        val blockedWebsites = mutableSetOf<String>()
                        obj.optJSONArray("blockedWebsites")?.let { sitesArr ->
                            for (i in 0 until sitesArr.length()) {
                                blockedWebsites.add(sitesArr.getString(i))
                            }
                        }

                        ActiveSession(
                            scheduleId = obj.optString("scheduleId", obj.optString("routineId", "")),
                            startTime = obj.getLong("startTime"),
                            blockedApps = blockedApps,
                            blockedWebsites = blockedWebsites
                        )
                    } catch (_: Exception) {
                        null
                    }
                }
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun saveActiveSessions(sessions: List<ActiveSession>) {
        val json = JSONArray().apply {
            sessions.forEach { session ->
                put(JSONObject().apply {
                    put("scheduleId", session.scheduleId)
                    put("routineId", session.scheduleId) // back-compat
                    put("startTime", session.startTime)
                    put("blockedApps", JSONArray(session.blockedApps.toList()))
                    put("blockedWebsites", JSONArray(session.blockedWebsites.toList()))
                })
            }
        }
        prefs.edit { putString(ACTIVE_SESSIONS_KEY, json.toString()) }
    }

    /**
     * Check if an app is blocked by ANY active schedule.
     * Returns the name of the blocking schedule, or null if not blocked.
     *
     * For MANUAL schedules: checks active sessions.
     * For DAILY/WEEKLY schedules: evaluates the time window in real-time.
     */
    fun isAppBlocked(packageName: String): Boolean {
        return findBlockingScheduleForApp(packageName) != null
    }

    /**
     * Find the schedule that blocks an app, or null if not blocked.
     */
    fun findBlockingScheduleForApp(packageName: String): Schedule? {
        val allSchedules = getAll().filter { it.isEnabled }
        val sessions = getActiveSessions()

        for (schedule in allSchedules) {
            if (!schedule.blockedApps.contains(packageName)) continue

            when (schedule.timing.type) {
                ScheduleTiming.ScheduleType.MANUAL -> {
                    if (sessions.any { it.scheduleId == schedule.id }) return schedule
                }
                ScheduleTiming.ScheduleType.DAILY,
                ScheduleTiming.ScheduleType.WEEKLY -> {
                    if (ScheduleManager.isScheduleActiveNow(schedule)) return schedule
                }
            }
        }
        return null
    }

    /**
     * Check if a website domain is blocked by ANY active schedule.
     * Returns the name of the blocking schedule, or null if not blocked.
     */
    fun isWebsiteBlocked(domain: String): Boolean {
        return findBlockingScheduleForWebsite(domain) != null
    }

    /**
     * Find the schedule that blocks a website domain, or null if not blocked.
     */
    fun findBlockingScheduleForWebsite(domain: String): Schedule? {
        val allSchedules = getAll().filter { it.isEnabled }
        val sessions = getActiveSessions()

        for (schedule in allSchedules) {
            val matchesDomain = schedule.blockedWebsites.any { blocked ->
                domain == blocked || domain.endsWith(".$blocked")
            }
            if (!matchesDomain) continue

            when (schedule.timing.type) {
                ScheduleTiming.ScheduleType.MANUAL -> {
                    if (sessions.any { it.scheduleId == schedule.id }) return schedule
                }
                ScheduleTiming.ScheduleType.DAILY,
                ScheduleTiming.ScheduleType.WEEKLY -> {
                    if (ScheduleManager.isScheduleActiveNow(schedule)) return schedule
                }
            }
        }
        return null
    }

    /**
     * Check if a specific schedule is currently active.
     */
    fun isScheduleActive(scheduleId: String): Boolean {
        val schedule = get(scheduleId) ?: return false
        if (!schedule.isEnabled) return false

        return when (schedule.timing.type) {
            ScheduleTiming.ScheduleType.MANUAL ->
                getActiveSessions().any { it.scheduleId == scheduleId }
            ScheduleTiming.ScheduleType.DAILY,
            ScheduleTiming.ScheduleType.WEEKLY ->
                ScheduleManager.isScheduleActiveNow(schedule)
        }
    }

    /** Well-known social media app package names. */
    val SOCIAL_MEDIA_PACKAGES = listOf(
        "com.instagram.android",
        "com.zhiliaoapp.musically",     // TikTok
        "com.twitter.android",
        "com.twitter.android.lite",
        "com.facebook.katana",           // Facebook
        "com.facebook.lite",
        "com.reddit.frontpage",
        "com.snapchat.android",
        "com.google.android.youtube",
        "com.linkedin.android",
        "com.pinterest",
        "com.tumblr",
    )

    val SOCIAL_MEDIA_DOMAINS = listOf(
        "instagram.com",
        "tiktok.com",
        "twitter.com",
        "x.com",
        "facebook.com",
        "reddit.com",
        "snapchat.com",
        "youtube.com",
        "linkedin.com",
        "pinterest.com",
        "tumblr.com",
    )

    /**
     * Creates a default "Social Media" schedule pre-filled with common
     * social media apps (only those installed) and websites.
     * Returns the list of installed social media app packages for the schedule.
     */
    fun createDefaults(context: Context) {
        if (getAll().isNotEmpty()) return // already have schedules

        val installedApps = SOCIAL_MEDIA_PACKAGES.filter { pkg ->
            try {
                context.packageManager.getApplicationInfo(pkg, 0)
                true
            } catch (_: Exception) {
                false
            }
        }

        val schedule = Schedule(
            id = UUID.randomUUID().toString(),
            name = "Social Media",
            isEnabled = false,
            timing = ScheduleTiming(type = ScheduleTiming.ScheduleType.MANUAL),
            blockedApps = installedApps,
            blockedWebsites = SOCIAL_MEDIA_DOMAINS,
            frictionWordCount = 5,
            autoReenableMinutes = 10
        )
        saveAll(listOf(schedule))
    }

    private fun parseSchedule(json: JSONObject): Schedule? = try {
        val timingJson = json.getJSONObject("schedule")
        val timing = ScheduleTiming(
            type = ScheduleTiming.ScheduleType.valueOf(timingJson.getString("type")),
            timeHour = timingJson.optInt("timeHour").takeIf { timingJson.has("timeHour") },
            timeMinute = timingJson.optInt("timeMinute").takeIf { timingJson.has("timeMinute") },
            endTimeHour = timingJson.optInt("endTimeHour").takeIf { timingJson.has("endTimeHour") },
            endTimeMinute = timingJson.optInt("endTimeMinute").takeIf { timingJson.has("endTimeMinute") },
            daysOfWeek = timingJson.optJSONArray("daysOfWeek")?.let { arr ->
                (0 until arr.length()).mapNotNull {
                    try { DayOfWeek.valueOf(arr.getString(it)) } catch (_: Exception) { null }
                }.toSet()
            } ?: emptySet(),
            isRecurring = timingJson.optBoolean("isRecurring", true)
        )

        val blockedApps = json.optJSONArray("blockedApps")?.let { arr ->
            (0 until arr.length()).map { arr.getString(it) }
        } ?: emptyList()

        val blockedWebsites = json.optJSONArray("blockedWebsites")?.let { arr ->
            (0 until arr.length()).map { arr.getString(it) }
        } ?: emptyList()

        Schedule(
            id = json.getString("id"),
            name = json.getString("name"),
            isEnabled = json.getBoolean("isEnabled"),
            timing = timing,
            blockedApps = blockedApps,
            blockedWebsites = blockedWebsites,
            frictionWordCount = json.optInt("frictionWordCount", 15),
            autoReenableMinutes = json.optInt("autoReenableMinutes", 1440),
            disabledUntil = if (json.has("disabledUntil")) json.optLong("disabledUntil") else null
        )
    } catch (_: Exception) {
        null
    }

    private fun scheduleToJson(schedule: Schedule) = JSONObject().apply {
        put("id", schedule.id)
        put("name", schedule.name)
        put("isEnabled", schedule.isEnabled)

        put("schedule", JSONObject().apply {
            val s = schedule.timing
            put("type", s.type.name)
            s.timeHour?.let { put("timeHour", it) }
            s.timeMinute?.let { put("timeMinute", it) }
            s.endTimeHour?.let { put("endTimeHour", it) }
            s.endTimeMinute?.let { put("endTimeMinute", it) }
            put("daysOfWeek", JSONArray().apply {
                s.daysOfWeek.forEach { put(it.name) }
            })
            put("isRecurring", s.isRecurring)
        })

        put("blockedApps", JSONArray(schedule.blockedApps))
        put("blockedWebsites", JSONArray(schedule.blockedWebsites))
        put("frictionWordCount", schedule.frictionWordCount)
        put("autoReenableMinutes", schedule.autoReenableMinutes)
        schedule.disabledUntil?.let { put("disabledUntil", it) }
    }
}
