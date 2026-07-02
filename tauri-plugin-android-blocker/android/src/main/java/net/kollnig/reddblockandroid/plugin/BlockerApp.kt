package net.kollnig.reddblockandroid.plugin

import android.app.Application
import android.util.Log
import androidx.work.Configuration
import net.kollnig.reddblockandroid.util.prefs

/**
 * Replaces the old standalone app's `App.kt`. Wired in via
 * `android:name` on the generated `gen/android` manifest's
 * `<application>` tag (see `docs/android-generated-project-manual-edits.md`).
 *
 * Deliberately does NOT call `Schedules.createDefaults()` — the
 * webview frontend is the source of truth for schedule data now (see
 * `set_schedules`); seeding a default schedule here would race with
 * the app.js upgrade-in-place migration on first launch after update.
 */
class BlockerApp : Application(), Configuration.Provider {

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        setupSafePreferences()
    }

    private fun setupSafePreferences() {
        val deviceContext = createDeviceProtectedStorageContext()
        deviceContext.moveSharedPreferencesFrom(this, "prefs")
        prefs = deviceContext.getSharedPreferences("prefs", MODE_PRIVATE)
    }
}
