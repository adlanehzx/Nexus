plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.facebook.react")
}

/**
 * Worker application.
 *
 * Manifest, Kotlin, and resources are kept at `android/src/main`
 * and referenced via `sourceSets`.
 */
val keystorePath: String? = System.getenv("NEXUS_KEYSTORE_PATH")
val keystorePassword: String? = System.getenv("NEXUS_KEYSTORE_PASSWORD")
val keyAlias: String? = System.getenv("NEXUS_KEY_ALIAS")
val keyPassword: String? = System.getenv("NEXUS_KEY_PASSWORD")

val signingReady: Boolean =
    !keystorePath.isNullOrBlank() &&
        file(keystorePath).exists() &&
        !keystorePassword.isNullOrBlank() &&
        !keyAlias.isNullOrBlank() &&
        !keyPassword.isNullOrBlank()

gradle.taskGraph.whenReady {
    if (signingReady) {
        logger.lifecycle("NEXUS: SIGNED release APK (keystore provided by environment).")
    } else {
        logger.lifecycle("NEXUS: UNSIGNED release APK - no keystore in environment.")
    }
}

react {
    root = file("../..")
    reactNativeDir = file("../../node_modules/react-native")
    hermesCommand = file("../../node_modules/react-native/sdks/hermesc")
        .absolutePath.replace("\\", "/") + "/%OS-BIN%/hermesc"
    codegenDir = file("../../node_modules/@react-native/codegen")

    entryFile = file("../../index.js")
}

android {
    namespace = "fr.nexus.worker"

    compileSdk = 36

    defaultConfig {
        applicationId = "fr.nexus.worker"

        minSdk = 30
        targetSdk = 35

        versionCode = 1
        versionName = "0.1.0"

        ndk {
            abiFilters += (project.properties["reactNativeArchitectures"] as String)
                .split(",")
                .map { it.trim() }
        }
    }

    sourceSets {
        named("main") {
            manifest.srcFile("../AndroidManifest.xml")
            java.srcDirs("../src/main/kotlin")
            res.srcDirs("../src/main/res")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (signingReady) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
        }

        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = if (signingReady) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
    }

    packaging {
        resources {
            excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
    implementation("com.facebook.react:hermes-android")

    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
