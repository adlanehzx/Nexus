package fr.nexus.worker

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Enregistre le module natif auprès de React Native.
 *
 * **Un seul module, et rien d'autre.** Ce fichier est le point exact où le code
 * JavaScript se voit accorder l'accès au système Android : ce qui n'est pas
 * listé ici n'existe pas pour lui. La liste tient en une ligne, et c'est
 * volontaire — la surface d'attaque du worker est celle de
 * `NexusWorkerModule`, énumérée méthode par méthode dans ce fichier et dans
 * `native-bridge.ts`.
 *
 * Aucun gestionnaire de vue : le worker ne dessine pas de composant natif. Son
 * écran de gestion est écrit en React Native ordinaire.
 *
 * L'autolinking n'est volontairement pas utilisé — la liste est écrite à la
 * main. Une dépendance native ajoutée par mégarde ne peut donc pas s'insérer
 * ici sans qu'on l'écrive, ce qui est exactement la propriété qu'on veut sur un
 * appareil qui détient un service d'accessibilité.
 */
class NexusWorkerPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(NexusWorkerModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
