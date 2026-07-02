package net.kollnig.reddblockandroid.schedule

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import net.kollnig.reddblockandroid.util.isPrefsInitialized
import net.kollnig.reddblockandroid.util.prefs

/**
 * Worker that ends a manual block's active session at a fixed timestamp.
 * Used for one-off "block for N minutes" blocks started via
 * `BlockerPlugin.startManualBlock`, which has no equivalent in the
 * original schedule model (that only ever toggled a manual schedule on
 * indefinitely, or auto-re-enabled after a temporary unlock).
 */
class StopSessionWorker(
    private val context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    override suspend fun doWork(): Result {
        if (!isPrefsInitialized) {
            val deviceContext = context.createDeviceProtectedStorageContext()
            prefs = deviceContext.getSharedPreferences("prefs", Context.MODE_PRIVATE)
        }

        val scheduleId = inputData.getString(KEY_SCHEDULE_ID) ?: return Result.failure()
        Schedules.stopSession(context, scheduleId)
        return Result.success()
    }

    companion object {
        const val KEY_SCHEDULE_ID = "schedule_id"
    }
}
