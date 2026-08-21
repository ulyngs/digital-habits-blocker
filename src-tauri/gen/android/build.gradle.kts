buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:9.1.1")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.21")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }

    // Tauri's published plugin crates (dialog, fs, opener, shell, and Tauri's own
    // `mobile/android` project) declare `consumerProguardFiles("consumer-rules.pro")`
    // in their bundled Android library projects, but the packaged crate does not
    // contain that file. AGP fails `merge<Variant>ConsumerProguardFiles` on the
    // missing path, so every release build dies before packaging — `pnpm
    // build:android` and `scripts/build-android-play.sh` alike. Debug builds do not
    // merge consumer rules, which is why android-ci.yml (debug only) stays green.
    //
    // Drop the entries whose file does not exist. Nothing is lost: the rules those
    // paths would have contributed were never shipped in the first place. Entries
    // that do resolve are left untouched, so a future crate release that ships the
    // file starts being honoured without another change here.
    afterEvaluate {
        val android = extensions.findByName("android")
        if (android is com.android.build.gradle.LibraryExtension) {
            android.defaultConfig.consumerProguardFiles.removeIf { !it.exists() }
        }
    }
}

tasks.register("clean").configure {
    delete("build")
}
