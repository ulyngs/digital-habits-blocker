package net.kollnig.reddblockandroid.plugin

import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import net.kollnig.reddblockandroid.data.Schedule
import net.kollnig.reddblockandroid.data.ScheduleTiming
import net.kollnig.reddblockandroid.schedule.ScheduleManager
import net.kollnig.reddblockandroid.schedule.Schedules
import net.kollnig.reddblockandroid.service.BlockerService
import net.kollnig.reddblockandroid.util.isAccessibilityServiceEnabled
import net.kollnig.reddblockandroid.util.isPrefsInitialized
import net.kollnig.reddblockandroid.util.prefs
import org.json.JSONArray
import java.time.DayOfWeek

@InvokeArg
class ScheduleEntryArg {
    lateinit var id: String
    lateinit var name: String
    var enabled: Boolean = true
    lateinit var type: String
    var startHour: Int? = null
    var startMinute: Int? = null
    var endHour: Int? = null
    var endMinute: Int? = null
    var days: List<String> = listOf()
    var blockedApps: List<String> = listOf()
    var blockedWebsites: List<String> = listOf()
    var frictionWordCount: Int = 15
    var emoji: String? = null
    var color: String? = null
    var isPaused: Boolean = false
    var pauseEndTimestampMs: Double? = null
    var activeFromTimestampMs: Double? = null
    var activeUntilTimestampMs: Double? = null
}

@InvokeArg
class SetSchedulesArgs {
    var schedules: List<ScheduleEntryArg> = listOf()
}

@InvokeArg
class ScheduleIdArg {
    lateinit var id: String
}

@InvokeArg
class StartManualBlockArgs {
    lateinit var id: String
    var endTimestampMs: Double? = null
}

@InvokeArg
class SetEventHandlerArgs {
    lateinit var handler: Channel
}

/**
 * Thin marshaling surface over the Kotlin blocking engine that used to
 * be redd-block-android's whole app. All the logic here already existed
 * verbatim in that app (`Schedules`, `ScheduleManager`, `BlockerService`)
 * — this class only translates between Tauri's `Invoke`/JS world and
 * those APIs. No blocking decisions or background work happen in this
 * file or in Rust; `BlockerService` (AccessibilityService) and
 * WorkManager keep running independently of the webview process.
 */
@TauriPlugin
class BlockerPlugin(private val activity: Activity) : Plugin(activity) {
    private var eventChannel: Channel? = null
    private var pendingFrictionGateEvent: JSObject? = null

    override fun load(webView: WebView) {
        super.load(webView)
        if (!isPrefsInitialized) {
            val deviceContext = activity.createDeviceProtectedStorageContext()
            prefs = deviceContext.getSharedPreferences("prefs", Activity.MODE_PRIVATE)
        }
        consumeFrictionGateExtras(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        consumeFrictionGateExtras(intent)
    }

    // Fires when the Activity comes back to the foreground — including
    // returning from the system Accessibility settings screen. This is
    // the reliable native-lifecycle signal for that; DOM `visibilitychange`
    // is known to fire inconsistently inside an Android WebView-hosted
    // Activity, unlike a real browser tab.
    override fun onResume() {
        super.onResume()
        val channel = eventChannel
        if (channel != null) {
            val event = JSObject()
            event.put("type", "resumed")
            channel.send(event)
        }
    }

    private fun consumeFrictionGateExtras(intent: Intent) {
        val scheduleId = intent.getStringExtra(BlockerService.EXTRA_SCHEDULE_ID) ?: return
        val scheduleName = intent.getStringExtra(BlockerService.EXTRA_SCHEDULE_NAME) ?: ""
        val blockedTarget = intent.getStringExtra(BlockerService.EXTRA_BLOCKED_TARGET) ?: ""

        val event = JSObject()
        event.put("type", "friction-gate")
        event.put("scheduleId", scheduleId)
        event.put("scheduleName", scheduleName)
        event.put("blockedTarget", blockedTarget)

        // Clear the extras so rotating the activity / re-reading the
        // intent later doesn't replay a stale friction-gate event.
        intent.removeExtra(BlockerService.EXTRA_SCHEDULE_ID)
        intent.removeExtra(BlockerService.EXTRA_SCHEDULE_NAME)
        intent.removeExtra(BlockerService.EXTRA_BLOCKED_TARGET)

        val channel = eventChannel
        if (channel != null) {
            channel.send(event)
        } else {
            pendingFrictionGateEvent = event
        }
    }

    @Command
    fun setEventHandler(invoke: Invoke) {
        val args = invoke.parseArgs(SetEventHandlerArgs::class.java)
        eventChannel = args.handler
        pendingFrictionGateEvent?.let {
            args.handler.send(it)
            pendingFrictionGateEvent = null
        }
        invoke.resolve(successObject())
    }

    // --- Permissions / onboarding ---

    @Command
    fun checkBlockerPermissions(invoke: Invoke) {
        val ret = JSObject()
        ret.put("accessibilityEnabled", activity.isAccessibilityServiceEnabled())
        ret.put("notificationsGranted", areNotificationsEnabled())
        invoke.resolve(ret)
    }

    @Command
    fun openAccessibilitySettings(invoke: Invoke) {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        invoke.resolve(successObject())
    }

    private fun areNotificationsEnabled(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val nm = activity.getSystemService(Activity.NOTIFICATION_SERVICE) as NotificationManager
            nm.areNotificationsEnabled()
        } else {
            true
        }
    }

    // --- Schedule sync ---

    /**
     * Replaces the full schedule set with what the webview sends.
     * Schedules whose id is no longer present in the payload are deleted.
     *
     * JS owns pause state: a paused entry is stored disabled (with
     * `disabledUntil`) and a [ReEnableWorker] is enqueued so blocking
     * resumes at the pause expiry even if the app process is dead —
     * mirroring iOS's one-off DeviceActivity and the desktop helper's
     * autonomous expiry.
     */
    @Command
    fun setSchedules(invoke: Invoke) {
        val args = invoke.parseArgs(SetSchedulesArgs::class.java)
        val existingById = Schedules.getAll().associateBy { it.id }
        val incomingIds = args.schedules.map { it.id }.toSet()

        for (entry in args.schedules) {
            val timing = ScheduleTiming(
                type = ScheduleTiming.ScheduleType.valueOf(entry.type),
                timeHour = entry.startHour,
                timeMinute = entry.startMinute,
                endTimeHour = entry.endHour,
                endTimeMinute = entry.endMinute,
                daysOfWeek = entry.days.mapNotNull {
                    try { DayOfWeek.valueOf(it) } catch (_: Exception) { null }
                }.toSet()
            )

            // Null pauseEndMs = paused indefinitely (until JS syncs it
            // unpaused); a timestamp arms a WorkManager re-enable below.
            val pauseEndMs = entry.pauseEndTimestampMs?.toLong()
            val pausedNow = entry.isPaused &&
                (pauseEndMs == null || pauseEndMs > System.currentTimeMillis())

            val activeFromMs = entry.activeFromTimestampMs?.toLong()
            val activeUntilMs = entry.activeUntilTimestampMs?.toLong()

            val existing = existingById[entry.id]
            val contentUnchanged = existing != null &&
                existing.timing == timing &&
                existing.blockedApps == entry.blockedApps &&
                existing.blockedWebsites == entry.blockedWebsites &&
                existing.frictionWordCount == entry.frictionWordCount &&
                existing.activeFromMs == activeFromMs &&
                existing.activeUntilMs == activeUntilMs

            val schedule = if (contentUnchanged && existing != null) {
                // Avoid rewriting unchanged schedules (Schedules.save also
                // touches active sessions); still apply name + pause state,
                // which JS owns.
                existing.copy(
                    name = entry.name,
                    emoji = entry.emoji,
                    color = entry.color,
                    isEnabled = entry.enabled && !pausedNow,
                    disabledUntil = if (pausedNow) pauseEndMs else null
                )
            } else {
                Schedule(
                    id = entry.id,
                    name = entry.name,
                    isEnabled = entry.enabled && !pausedNow,
                    timing = timing,
                    blockedApps = entry.blockedApps,
                    blockedWebsites = entry.blockedWebsites,
                    frictionWordCount = entry.frictionWordCount,
                    emoji = entry.emoji,
                    color = entry.color,
                    disabledUntil = if (pausedNow) pauseEndMs else null,
                    activeFromMs = activeFromMs,
                    activeUntilMs = activeUntilMs
                )
            }
            Schedules.save(schedule, activity)

            if (pausedNow && pauseEndMs != null) {
                ScheduleManager.scheduleReEnable(
                    activity, entry.id, pauseEndMs - System.currentTimeMillis()
                )
            } else {
                ScheduleManager.cancelReEnable(activity, entry.id)
            }
        }

        for ((id, _) in existingById) {
            if (id !in incomingIds) {
                Schedules.delete(id, activity)
                ScheduleManager.cancelReEnable(activity, id)
            }
        }

        invoke.resolve(successObject())
    }

    @Command
    fun startManualBlock(invoke: Invoke) {
        val args = invoke.parseArgs(StartManualBlockArgs::class.java)
        val schedule = Schedules.get(args.id)
        if (schedule == null) {
            invoke.resolve(errorObject("Schedule not found: ${args.id}"))
            return
        }

        ScheduleManager.cancelStopSession(activity, args.id)
        Schedules.startSession(activity, schedule)

        val endTimestampMs = args.endTimestampMs
        if (endTimestampMs != null) {
            val delayMs = endTimestampMs.toLong() - System.currentTimeMillis()
            if (delayMs > 0) {
                ScheduleManager.scheduleStopSession(activity, args.id, delayMs)
            } else {
                Schedules.stopSession(activity, args.id)
            }
        }

        invoke.resolve(successObject())
    }

    @Command
    fun stopManualBlock(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleIdArg::class.java)
        ScheduleManager.cancelStopSession(activity, args.id)
        Schedules.stopSession(activity, args.id)
        invoke.resolve(successObject())
    }

    /**
     * Reports each Kotlin schedule entity's enabled/pause state so the
     * webview can reconcile pauses granted by the native friction gate
     * (UnlockActivity) while the webview process was dead.
     */
    @Command
    fun getScheduleStates(invoke: Invoke) {
        val arr = JSArray()
        for (schedule in Schedules.getAll()) {
            val entry = JSObject()
            entry.put("id", schedule.id)
            entry.put("isEnabled", schedule.isEnabled)
            schedule.disabledUntil?.let { entry.put("disabledUntil", it.toDouble()) }
            arr.put(entry)
        }
        val ret = JSObject()
        ret.put("states", arr)
        invoke.resolve(ret)
    }

    // --- Migration ---

    @Command
    fun readNativeSchedules(invoke: Invoke) {
        val ret = JSObject()
        ret.put("routinesJson", prefs.getString("routines", "[]"))
        ret.put("activeSessionsJson", prefs.getString("active_routine_sessions", "[]"))
        invoke.resolve(ret)
    }

    // --- App picker ---

    /** Return the persisted label/package snapshot without touching PackageManager. */
    @Command
    fun getCachedInstalledApps(invoke: Invoke) {
        val arr = JSArray()
        val cached = prefs.getString(INSTALLED_APPS_CACHE_KEY, null)
        if (cached != null) {
            try {
                val entries = JSONArray(cached)
                for (index in 0 until entries.length()) {
                    val entry = entries.optJSONObject(index) ?: continue
                    val packageName = entry.optString("packageName")
                    if (packageName.isEmpty()) continue
                    val appEntry = JSObject()
                    appEntry.put("label", entry.optString("label", packageName))
                    appEntry.put("packageName", packageName)
                    arr.put(appEntry)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Ignoring malformed installed-app cache", e)
            }
        }
        val ret = JSObject()
        ret.put("apps", arr)
        invoke.resolve(ret)
    }

    /**
     * Refresh launcher labels when the app picker opens, then persist the
     * lightweight label/package snapshot for later launches.
     */
    @Command
    fun getInstalledApps(invoke: Invoke) {
        val pm = activity.packageManager
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = pm.queryIntentActivities(launcherIntent, 0)

        val arr = JSArray()
        val cached = JSONArray()
        val seen = mutableSetOf<String>()
        for (info in resolved) {
            val pkg = info.activityInfo.packageName
            if (pkg == activity.packageName || !seen.add(pkg)) continue
            val label = info.loadLabel(pm).toString()

            val appEntry = JSObject()
            appEntry.put("label", label)
            appEntry.put("packageName", pkg)
            arr.put(appEntry)

            val cachedEntry = org.json.JSONObject()
            cachedEntry.put("label", label)
            cachedEntry.put("packageName", pkg)
            cached.put(cachedEntry)
        }

        prefs.edit().putString(INSTALLED_APPS_CACHE_KEY, cached.toString()).apply()

        val ret = JSObject()
        ret.put("apps", arr)
        invoke.resolve(ret)
    }

    private fun successObject(): JSObject {
        val obj = JSObject()
        obj.put("success", true)
        return obj
    }

    private fun errorObject(message: String): JSObject {
        val obj = JSObject()
        obj.put("success", false)
        obj.put("error", message)
        return obj
    }

    companion object {
        private const val INSTALLED_APPS_CACHE_KEY = "installed_apps_cache_v1"
        private const val TAG = "BlockerPlugin"
    }
}
