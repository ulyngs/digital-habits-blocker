package net.kollnig.reddblockandroid.util

import android.content.SharedPreferences

lateinit var prefs: SharedPreferences

val isPrefsInitialized: Boolean
    get() = ::prefs.isInitialized
