package net.kollnig.reddblockandroid.util

import android.content.Context
import android.provider.Settings

fun Context.isAccessibilityServiceEnabled(): Boolean {
    val serviceName = "$packageName/$packageName.service.BlockerService"
    val serviceNameShort = "$packageName/.service.BlockerService"
    val enabledServices = Settings.Secure.getString(
        contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
    )
    return enabledServices?.contains(serviceName) == true ||
            enabledServices?.contains(serviceNameShort) == true
}
