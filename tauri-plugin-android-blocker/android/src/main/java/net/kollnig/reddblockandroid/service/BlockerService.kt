package net.kollnig.reddblockandroid.service

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import net.kollnig.reddblockandroid.schedule.Schedules

import net.kollnig.reddblockandroid.util.isPrefsInitialized
import net.kollnig.reddblockandroid.util.prefs
import androidx.core.net.toUri

@SuppressLint("AccessibilityPolicy")
class BlockerService : AccessibilityService() {

    private var lastCheckedUrl: String? = null
    private var lastUrlCheckTime: Long = 0
    private val URL_CHECK_THROTTLE_MS = 500L

    private var lastBlockedPkg: String? = null
    private var lastBlockedTime: Long = 0
    private val APP_BLOCK_THROTTLE_MS = 2000L

    override fun onServiceConnected() {
        super.onServiceConnected()

        if (!isPrefsInitialized) {
            val deviceContext = createDeviceProtectedStorageContext()
            prefs = deviceContext.getSharedPreferences("prefs", MODE_PRIVATE)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val keyguardManager = getSystemService(KEYGUARD_SERVICE) as android.app.KeyguardManager
        if (keyguardManager.isKeyguardLocked) return

        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return

        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName) return

        // Check for website blocking in supported browsers
        if (isSupportedBrowser(pkg)) {
            val currentTime = System.currentTimeMillis()
            if (currentTime - lastUrlCheckTime >= URL_CHECK_THROTTLE_MS) {
                val url = extractUrlFromEvent(event)
                if (url != null) {
                    lastUrlCheckTime = currentTime
                    if (url != lastCheckedUrl) {
                        lastCheckedUrl = url
                        val domain = extractDomain(url)
                        if (domain != null) {
                            val blockingSchedule = Schedules.findBlockingScheduleForWebsite(domain)
                            if (blockingSchedule != null) {
                                Log.d(TAG, "Blocking website $domain in browser ($pkg)")
                                navigateBrowserToBlank(pkg)
                                launchFrictionGate(blockingSchedule.id, blockingSchedule.name, domain)
                                return
                            }
                        }
                    }
                }
            }
        }

        // Check app blocking
        if (shouldSkipPackage(pkg)) return

        val blockingSchedule = Schedules.findBlockingScheduleForApp(pkg)
        if (blockingSchedule != null) {
            val now = System.currentTimeMillis()
            if (pkg != lastBlockedPkg || now - lastBlockedTime >= APP_BLOCK_THROTTLE_MS) {
                lastBlockedPkg = pkg
                lastBlockedTime = now
                Log.d(TAG, "Blocking app $pkg by schedule: $blockingSchedule")
                val appLabel = getAppLabel(pkg)
                launchFrictionGate(blockingSchedule.id, blockingSchedule.name, appLabel)
            }
        }
    }

    /**
     * Launches the Tauri main activity (the webview UI) with the block
     * details as extras, instead of a standalone native UnlockActivity.
     * `BlockerPlugin` reads these extras from `load()` (cold start) or
     * `onNewIntent()` (warm start) and forwards them to the webview as a
     * `friction-gate` event, where the override-challenge UI lives now.
     */
    private fun launchFrictionGate(scheduleId: String, scheduleName: String, blockedTarget: String) {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName) ?: return
        val intent = Intent(launchIntent).apply {
            putExtra(EXTRA_SCHEDULE_ID, scheduleId)
            putExtra(EXTRA_SCHEDULE_NAME, scheduleName)
            putExtra(EXTRA_BLOCKED_TARGET, blockedTarget)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(intent)
    }

    private fun getAppLabel(packageName: String): String {
        return try {
            this.packageManager.getApplicationLabel(
                this.packageManager.getApplicationInfo(packageName, 0)
            ).toString()
        } catch (_: Exception) {
            packageName
        }
    }

    private fun shouldSkipPackage(packageName: String): Boolean {
        return try {
            val info = this.packageManager.getApplicationInfo(packageName, 0)
            val isSystem = (info.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
            if (isSystem) {
                this.packageManager.getLaunchIntentForPackage(packageName) == null
            } else {
                false
            }
        } catch (_: Exception) {
            false
        }
    }

    /** Maps browser package names to their URL bar view IDs */
    private val browserUrlViewIds = mapOf(
        // Firefox variants
        "org.mozilla.firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX"),
        "org.mozilla.firefox_beta" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX"),
        "org.mozilla.fenix" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX"),
        "org.mozilla.fenix.nightly" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX"),
        "org.mozilla.focus" to listOf("mozac_browser_toolbar_url_view", "url_bar_title", "ADDRESSBAR_URL_BOX"),
        // Chrome / Chromium
        "com.android.chrome" to listOf("url_bar", "origin", "display_url"),
        "com.chrome.beta" to listOf("url_bar", "display_url"),
        "org.chromium.chrome" to listOf("url_bar", "display_url"),
        // Brave
        "com.brave.browser" to listOf("url_bar", "display_url"),
        "com.brave.browser_beta" to listOf("url_bar", "display_url"),
        "com.brave.browser_nightly" to listOf("url_bar", "display_url"),
        // Samsung Internet
        "com.sec.android.app.sbrowser" to listOf("location_bar_edit_text"),
        // Microsoft Edge
        "com.microsoft.emmx" to listOf("url_bar"),
        // Opera variants
        "com.opera.browser" to listOf("url_field"),
        "com.opera.browser.beta" to listOf("url_field"),
        "com.opera.mini.native" to listOf("url_field"),
        "com.opera.mini.native.beta" to listOf("url_field"),
        "com.opera.touch" to listOf("addressbarEdit"),
        // Vivaldi
        "com.vivaldi.browser" to listOf("url_bar", "display_url"),
        // Kiwi Browser
        "com.kiwibrowser.browser" to listOf("url_bar", "display_url"),
        // DuckDuckGo
        "com.duckduckgo.mobile.android" to listOf("omnibarTextInput"),
        // Ecosia
        "com.ecosia.android" to listOf("url_bar"),
        // Huawei Browser
        "com.huawei.browser" to listOf("url_bar"),
        // Android system browser (AOSP)
        "com.android.browser" to listOf("url"),
        // Google Search app (in-app browser)
        "com.google.android.googlequicksearchbox" to listOf("googleapp_srp_search_box_text"),
    )

    private fun isSupportedBrowser(packageName: String): Boolean {
        return packageName in browserUrlViewIds
    }

    private fun navigateBrowserToBlank(browserPackage: String) {
        try {
            val uri = "https://reddfocus.org".toUri()
            val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                setPackage(browserPackage)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(intent)
            lastCheckedUrl = null
        } catch (e: Exception) {
            Log.e(TAG, "Failed to navigate browser to blocked page", e)
            performGlobalAction(GLOBAL_ACTION_HOME)
        }
    }

    private fun extractUrlFromEvent(event: AccessibilityEvent): String? {
        val root = rootInActiveWindow ?: return null
        try {
            val pkg = event.packageName?.toString() ?: return null
            val viewIds = browserUrlViewIds[pkg] ?: return null
            val knownUrlViewIds = viewIds.map { "$pkg:id/$it" } + viewIds

            // First try the standard API with fully-qualified resource IDs
            for (viewId in knownUrlViewIds) {
                val nodes = root.findAccessibilityNodeInfosByViewId(viewId)
                if (nodes.isNullOrEmpty()) continue
                val url = extractUrlFromNodes(nodes)
                if (url != null) return url
            }

            // Fallback: manually traverse the tree to find nodes by bare resource-id.
            // Newer browsers (e.g. Firefox with Jetpack Compose) use test tags as
            // resource-ids without the "package:id/" prefix, which
            // findAccessibilityNodeInfosByViewId cannot match.
            val bareIds = viewIds.toSet()
            val fallbackNodes = mutableListOf<android.view.accessibility.AccessibilityNodeInfo>()
            findNodesByBareResourceId(root, bareIds, fallbackNodes)
            if (fallbackNodes.isNotEmpty()) {
                val url = extractUrlFromNodes(fallbackNodes)
                if (url != null) return url
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error extracting URL", e)
        } finally {
            root.recycle()
        }
        return null
    }

    private fun extractUrlFromNodes(
        nodes: List<android.view.accessibility.AccessibilityNodeInfo>
    ): String? {
        for (node in nodes) {
            try {
                // Skip if the URL bar is focused — user is typing,
                // don't block on autocomplete suggestions
                if (node.isFocused) continue
                val rawText = node.text?.toString()?.takeIf { it.isNotBlank() }
                    ?: node.contentDescription?.toString()
                if (rawText != null) {
                    val words = rawText.split("\\s+".toRegex())
                    for (word in words) {
                        val cleanWord = word.trimEnd('.', ',')
                        if (isValidUrlFormat(cleanWord)) {
                            return cleanWord
                        }
                    }
                }
            } finally {
                node.recycle()
            }
        }
        return null
    }

    /** Recursively walks the accessibility tree looking for nodes whose
     *  viewIdResourceName matches one of [targetIds] (bare, without package prefix). */
    private fun findNodesByBareResourceId(
        node: android.view.accessibility.AccessibilityNodeInfo,
        targetIds: Set<String>,
        results: MutableList<android.view.accessibility.AccessibilityNodeInfo>
    ) {
        val resName = node.viewIdResourceName
        if (resName != null && resName in targetIds) {
            results.add(android.view.accessibility.AccessibilityNodeInfo.obtain(node))
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findNodesByBareResourceId(child, targetIds, results)
            child.recycle()
        }
    }

    private fun isValidUrlFormat(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true
        if (trimmed.contains(" ") || trimmed.length < 4) return false
        val domainPattern = Regex("^[a-zA-Z0-9][a-zA-Z0-9.-]*\\.[a-zA-Z]{2,}(/.*)?$")
        return domainPattern.matches(trimmed)
    }

    private fun extractDomain(url: String): String? {
        return try {
            var normalizedUrl = url.trim()
            if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
                normalizedUrl = "https://$normalizedUrl"
            }
            val uri = java.net.URI(normalizedUrl)
            uri.host?.lowercase()?.removePrefix("www.")
        } catch (e: Exception) {
            Log.e(TAG, "Error extracting domain from URL: $url", e)
            null
        }
    }

    override fun onInterrupt() {}

    companion object {
        private const val TAG = "BlockerService"
        const val EXTRA_SCHEDULE_ID = "friction_schedule_id"
        const val EXTRA_SCHEDULE_NAME = "friction_schedule_name"
        const val EXTRA_BLOCKED_TARGET = "friction_blocked_target"
    }
}
