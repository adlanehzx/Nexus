package fr.nexus.worker

import android.app.Application
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.shell.MainReactPackage
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

/**
 * L'application Android du worker.
 *
 * Elle héberge le moteur JavaScript dans lequel tourne le worker NEXUS — le même
 * code TypeScript que les tests exercent, et le même `WorkerRuntime` que le
 * worker Windows. Le Kotlin ne décide de rien : il fournit un moteur, un module
 * natif, et un service qui maintient le processus en vie.
 *
 * **Ce n'est pas un client NEXUS.** Aucune conversation, aucun jeton
 * d'utilisateur, aucun flux d'événements client : le téléphone s'authentifie
 * comme *appareil*, avec la clé de son magasin de clés, et n'exécute que ce que
 * le cœur lui confie.
 */
class NexusWorkerApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {

            /**
             * Les paquets natifs, écrits à la main.
             *
             * `PackageList` — l'autolinking — n'est pas utilisé : ce worker n'a
             * aucune dépendance native tierce, et la liste explicite garantit
             * qu'aucune ne peut s'ajouter sans passer par une revue. Sur un
             * appareil qui détient un service d'accessibilité, une bibliothèque
             * native introduite par transitivité n'est pas un détail.
             */
            override fun getPackages(): List<ReactPackage> =
                listOf(
                    // Les modules de base de React Native — `AppState`, `Timing`,
                    // `Networking`, `WebSocketModule`. Dans le modele standard ils
                    // arrivent par `PackageList`, la classe generee par
                    // l'autolinking ; en l'ecartant, il faut les nommer.
                    MainReactPackage(),
                    NexusWorkerPackage(),
                )

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

            // Architecture historique : le module natif est un
            // `ReactContextBaseJavaModule` classique, et le worker n'a aucun
            // composant d'interface natif à rendre. Migrer coûterait une
            // réécriture du pont sans rien apporter à un worker sans interface.
            override val isNewArchEnabled: Boolean = false
            override val isHermesEnabled: Boolean = true
        }

    override fun onCreate() {
        super.onCreate()
        // `OpenSourceMergedSoMapping` et non le drapeau historique : React Native
        // 0.81 fusionne ses bibliotheques natives dans un seul `libreactnative.so`,
        // et sans cette table SoLoader cherche des fichiers `.so` qui n'existent
        // plus — l'application s'arrete au premier acces aux drapeaux natifs.
        SoLoader.init(this, OpenSourceMergedSoMapping)
    }
}
