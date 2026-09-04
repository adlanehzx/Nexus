package fr.nexus.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Redémarre le worker après un redémarrage du téléphone.
 *
 * ## Ce qu'il fait, et le peu qu'il fait
 *
 * Il démarre le service de premier plan. Point. La suite est exactement celle
 * d'un démarrage ordinaire :
 *
 *     BOOT → service → moteur JavaScript → WorkerRuntime
 *          → authentification → poignée de main → cœur
 *
 * **Il n'exécute jamais une capacité.** Un récepteur de diffusion est déclenché
 * par le système, hors de toute session : si une capacité pouvait partir d'ici,
 * elle s'exécuterait sans authentification, sans autorisation, sans tâche — et
 * un redémarrage deviendrait un déclencheur d'action. Il n'y a donc aucun chemin
 * d'ici vers `LocalCapabilityRegistry`.
 *
 * L'action reçue est vérifiée plutôt que supposée : `BOOT_COMPLETED` est une
 * diffusion protégée, que seul le système peut émettre, mais un récepteur
 * exporté reçoit ce qu'on lui envoie et ne doit pas agir sur une intention qu'il
 * n'attendait pas.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        // `applicationContext` : le contexte du récepteur meurt à la fin de
        // `onReceive`, et le service lui survit.
        WorkerForegroundService.start(context.applicationContext)
    }
}
