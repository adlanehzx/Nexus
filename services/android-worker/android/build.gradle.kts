/**
 * Reglages communs a tous les modules.
 *
 * Les versions sont celles qu'attend React Native 0.81.5 : les changer sans
 * necessite casserait la compilation du greffon natif, qui n'est pas compile ici
 * mais consomme depuis Maven.
 */
plugins {
    id("com.android.application") version "8.11.0" apply false
    id("org.jetbrains.kotlin.android") version "2.1.20" apply false
    id("com.facebook.react.rootproject")
}
