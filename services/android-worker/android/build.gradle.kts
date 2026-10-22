/**
 * Common settings for all modules.
 *
 * Versions are those expected by React Native 0.81.5: changing them unnecessarily
 * breaks native plugin compilation, which is consumed from Maven.
 */
plugins {
    id("com.android.application") version "8.11.0" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("com.facebook.react.rootproject")
}
