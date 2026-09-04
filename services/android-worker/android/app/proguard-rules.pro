# Regles de reduction pour la version de production.
#
# React Native accede a une partie du code par reflexion : le pont natif
# resout les methodes @ReactMethod par leur nom. Les supprimer casserait le
# worker sans erreur de compilation.
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class fr.nexus.worker.NexusWorkerModule { *; }
-keep class fr.nexus.worker.NexusAccessibilityService { *; }
-keepclassmembers class * { @com.facebook.react.bridge.ReactMethod *; }
