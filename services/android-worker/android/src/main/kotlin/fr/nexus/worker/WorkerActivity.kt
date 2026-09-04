package fr.nexus.worker

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * L'écran de gestion du worker.
 *
 * **Ce n'est pas l'interface NEXUS.** On ne discute pas avec l'assistant ici :
 * l'iPhone et le portable Windows restent les clients. Cet écran ne répond qu'à
 * trois questions — le téléphone est-il connecté, que sait-il faire, et que
 * manque-t-il pour le reste — et propose le chemin exact vers le réglage Android
 * concerné. Le contenu est dans `ui/WorkerScreen.tsx`.
 *
 * L'activité n'exécute aucune capacité et ne parle pas au cœur. Elle affiche ce
 * que `AndroidWorker.describe()` rapporte, qui ne contient aucun secret.
 *
 * Elle démarre le service de premier plan à l'ouverture : sur MIUI, démarrer un
 * service depuis l'arrière-plan est souvent refusé, alors qu'il est autorisé
 * quand une activité de l'application est au premier plan. Ouvrir l'écran est
 * donc le geste qui remet le worker en marche après un arrêt par le système.
 */
class WorkerActivity : ReactActivity() {

    override fun getMainComponentName(): String = "NexusWorker"

    // `fabricEnabled = false` : le rendu Fabric appartient a la nouvelle
    // architecture, desactivee ici (voir NexusWorkerApplication). L'activer sans
    // le reste ne compilerait pas le pont natif existant.
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName ?: "NexusWorker", false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WorkerForegroundService.start(this)
    }
}
