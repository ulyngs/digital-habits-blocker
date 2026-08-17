import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing is supplied by scripts/build-android-play.sh through the
// macOS Keychain. Keep the credentials out of the repository and preserve the
// debug-signing fallback for ordinary local builds.
val playKeystore = System.getenv("REDD_BLOCK_ANDROID_KEYSTORE")
val playStorePassword = System.getenv("REDD_BLOCK_ANDROID_STORE_PASSWORD")
val playKeyAlias = System.getenv("REDD_BLOCK_ANDROID_KEY_ALIAS")
val playKeyPassword = System.getenv("REDD_BLOCK_ANDROID_KEY_PASSWORD")
val playSigningConfigured = listOf(
    playKeystore,
    playStorePassword,
    playKeyAlias,
    playKeyPassword,
).all { !it.isNullOrBlank() }

android {
    compileSdk = 36
    namespace = "net.kollnig.reddblockandroid"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "net.kollnig.reddblockandroid"
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    signingConfigs {
        if (playSigningConfigured) {
            create("playRelease") {
                storeFile = file(playKeystore!!)
                storePassword = playStorePassword
                keyAlias = playKeyAlias
                keyPassword = playKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = if (playSigningConfigured) {
                signingConfigs.getByName("playRelease")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlin {
        compilerOptions {
            jvmTarget = JvmTarget.JVM_1_8
        }
    }
    buildFeatures {
        buildConfig = true
    }
    lint {
        // `lintVitalAnalyze<Flavor>Release` crashes inside Kotlin's FIR resolver
        // ("`findFirCompiledSymbol` only works on compiled declarations") while
        // UAST-visiting the project's own .gradle.kts build scripts — an AGP 9.1.1
        // / Kotlin 2.2.21 bug, not a finding about this code. It aborts every
        // release build. Nothing in CI runs lint (see testing.md), so this turns a
        // hard build failure into the status quo rather than dropping a live gate.
        checkReleaseBuilds = false
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.17.0")
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("com.google.android.material:material:1.14.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}

apply(from = "tauri.build.gradle.kts")
