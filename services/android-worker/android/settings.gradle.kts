/**
 * Gradle project for NEXUS Android worker.
 *
 * React Native Gradle plugin is sourced from `node_modules` via `includeBuild` —
 * official React Native mechanism avoiding out-of-sync plugin versions.
 */
pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("com.facebook.react.settings")
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nexus-android-worker"
include(":app")

/*
 * Autolinking: intentionally empty.
 *
 * All packages are manually registered in `NexusWorkerApplication.getPackages()`.
 */
val autolinking = file("build/generated/autolinking/autolinking.json")
autolinking.parentFile.mkdirs()
autolinking.writeText(
    """
    {
      "reactNativeVersion": "0.81.5",
      "dependencies": {},
      "project": { "android": { "packageName": "fr.nexus.worker" } }
    }
    """.trimIndent()
)
