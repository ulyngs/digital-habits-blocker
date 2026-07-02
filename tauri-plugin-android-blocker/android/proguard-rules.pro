# Tauri invokes @Command methods via reflection.
-keep class net.kollnig.reddblockandroid.plugin.** { *; }

# WorkManager instantiates Worker subclasses via reflection.
-keep class net.kollnig.reddblockandroid.schedule.ReEnableWorker { *; }
-keep class net.kollnig.reddblockandroid.schedule.StopSessionWorker { *; }

# AccessibilityService is referenced by fully-qualified name from the manifest.
-keep class net.kollnig.reddblockandroid.service.BlockerService { *; }
