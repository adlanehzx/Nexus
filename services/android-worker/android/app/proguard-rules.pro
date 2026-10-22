# Production shrinker rules. React Native resolves @ReactMethod members by name.
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class fr.nexus.worker.NexusWorkerModule { *; }
-keep class fr.nexus.worker.NexusAccessibilityService { *; }
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod *; }
