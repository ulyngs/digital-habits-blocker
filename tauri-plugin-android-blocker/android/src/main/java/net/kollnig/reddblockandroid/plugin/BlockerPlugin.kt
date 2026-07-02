package net.kollnig.reddblockandroid.plugin

import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.core.graphics.drawable.toBitmap
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
import java.io.ByteArrayOutputStream
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
    var autoReenableMinutes: Int = 1440
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
     * Replaces the full schedule set with what the webview sends. Kotlin
     * stays authoritative for runtime state (`isEnabled` / `disabledUntil`)
     * on any schedule whose id + blocking content is unchanged, so a
     * re-sync from JS can't clobber an in-progress temporary unlock.
     * Schedules whose id is no longer present in the payload are deleted.
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

            val existing = existingById[entry.id]
            val contentUnchanged = existing != null &&
                existing.timing == timing &&
                existing.blockedApps == entry.blockedApps &&
                existing.blockedWebsites == entry.blockedWebsites &&
                existing.frictionWordCount == entry.frictionWordCount &&
                existing.autoReenableMinutes == entry.autoReenableMinutes

            val schedule = if (contentUnchanged && existing != null) {
                // Keep Kotlin's runtime isEnabled/disabledUntil; only
                // update the fields JS actually owns (name).
                existing.copy(name = entry.name)
            } else {
                Schedule(
                    id = entry.id,
                    name = entry.name,
                    isEnabled = entry.enabled,
                    timing = timing,
                    blockedApps = entry.blockedApps,
                    blockedWebsites = entry.blockedWebsites,
                    frictionWordCount = entry.frictionWordCount,
                    autoReenableMinutes = entry.autoReenableMinutes,
                    disabledUntil = null
                )
            }
            Schedules.save(schedule, activity)
        }

        for ((id, _) in existingById) {
            if (id !in incomingIds) {
                Schedules.delete(id, activity)
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

    @Command
    fun temporaryUnlock(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleIdArg::class.java)
        Schedules.temporaryUnlock(activity, args.id)
        invoke.resolve(successObject())
    }

    @Command
    fun getBlockingState(invoke: Invoke) {
        val ret = JSObject()
        val arr = JSArray()
        for (schedule in Schedules.getAll()) {
            val entry = JSObject()
            entry.put("id", schedule.id)
            entry.put("isActiveNow", Schedules.isScheduleActive(schedule.id))
            schedule.disabledUntil?.let { entry.put("disabledUntil", it) }
            arr.put(entry)
        }
        ret.put("schedules", arr)
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

    @Command
    fun getInstalledApps(invoke: Invoke) {
        val pm = activity.packageManager
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val resolved = pm.queryIntentActivities(launcherIntent, 0)

        val arr = JSArray()
        val seen = mutableSetOf<String>()
        for (info in resolved) {
            val pkg = info.activityInfo.packageName
            if (pkg == activity.packageName || !seen.add(pkg)) continue

            val appEntry = JSObject()
            appEntry.put("label", info.loadLabel(pm).toString())
            appEntry.put("packageName", pkg)
            try {
                val icon = info.loadIcon(pm).toBitmap(width = 96, height = 96)
                val stream = ByteArrayOutputStream()
                icon.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, stream)
                appEntry.put("iconBase64", Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP))
            } catch (e: Exception) {
                Log.w(TAG, "Failed to load icon for $pkg", e)
            }
            arr.put(appEntry)
        }

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
        private const val TAG = "BlockerPlugin"
    }
}
