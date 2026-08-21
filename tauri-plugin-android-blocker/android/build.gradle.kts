plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.kollnig.reddblockandroid.plugin"
    compileSdk = 36

    defaultConfig {
        minSdk = 26

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("proguard-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    kotlinOptions {
        jvmTarget = "11"
    }
    testOptions {
        unitTests {
            // SchedulesTest drives real persistence code, which logs through
            // android.util.Log. Without this the stubbed android.jar throws
            // "not mocked" on the first Log.d rather than running the test.
            // Robolectric-run tests supply their own framework implementation
            // and are unaffected by this flag.
            isReturnDefaultValues = true
            // Robolectric needs the merged resources to inflate
            // R.layout.activity_unlock and resolve R.string / R.color.
            isIncludeAndroidResources = true
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation(project(":tauri-android"))
    // JVM unit tests for the pure blocking logic (BrowserUrlParser, Schedules):
    //   src-tauri/gen/android/gradlew :tauri-plugin-android-blocker:testDebugUnitTest
    testImplementation("junit:junit:4.13.2")
    // Schedules persists through org.json. The stubbed android.jar returns
    // default values for it under isReturnDefaultValues, which would make every
    // round-trip silently produce empty data; this puts a real implementation
    // ahead of the stub on the unit-test classpath.
    testImplementation("org.json:json:20240303")
    // Robolectric runs UnlockActivity and BlockerService against a real
    // framework implementation on the JVM — they are an Activity and an
    // AccessibilityService, so neither can be exercised by plain JUnit.
    // Pinned SDK level lives in src/test/resources/robolectric.properties.
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.test:core:1.6.1")
    // UnlockActivity's confirm path reaches Schedules.pauseSchedule, which
    // enqueues a ReEnableWorker; without a test WorkManager that call throws.
    testImplementation("androidx.work:work-testing:2.10.0")
}
