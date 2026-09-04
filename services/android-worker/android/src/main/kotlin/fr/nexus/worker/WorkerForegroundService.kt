package fr.nexus.worker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.ReactApplication

/**
 * Service de premier plan : il maintient le worker en vie, et rien d'autre.
 *
 * ## Ce qu'il fait
 *
 * Trois choses, et elles sont toutes du cycle de vie :
 *
 *  1. il affiche la notification permanente qu'Android exige — ce qui est une
 *     bonne chose, l'utilisateur voit en permanence que le worker tourne ;
 *  2. il maintient le processus vivant quand l'écran est éteint, pour que la
 *     WebSocket sortante survive ;
 *  3. il démarre le moteur JavaScript, dans lequel `WorkerRuntime` fait tout le
 *     reste.
 *
 * ## Ce qu'il n'est pas
 *
 * **Ce n'est pas un exécutant parallèle.** Il ne reçoit aucune commande,
 * n'exécute aucune capacité, ne parle pas au cœur, et ne contourne ni les
 * permissions ni `WorkerRuntime`. L'architecture est strictement :
 *
 *     ForegroundService → cycle de vie → WorkerRuntime → WorkerLink → cœur
 *
 * Trois propriétés le garantissent, et elles sont vérifiables :
 *
 *  - `onBind` renvoie `null` : **aucun canal de commande** ne peut s'y attacher.
 *    Une application tierce ne peut pas s'y lier, et notre propre code non plus.
 *  - le service est `exported="false"` au manifeste : seule cette application
 *    peut le démarrer.
 *  - les seules actions reconnues sont démarrer et arrêter. Une intention
 *    inconnue est ignorée, et n'emporte aucune donnée exécutable — il n'y a pas
 *    de champ « commande » à lire.
 */
class WorkerForegroundService : Service() {

    companion object {
        private const val TAG = "NexusWorker"

        /** Les deux seules actions reconnues. Il n'y en aura pas de troisième. */
        const val ACTION_START = "fr.nexus.worker.action.START"
        const val ACTION_STOP = "fr.nexus.worker.action.STOP"

        private const val CHANNEL_ID = "nexus.worker.connection"
        private const val NOTIFICATION_ID = 42

        /**
         * Démarre le service depuis l'application elle-même.
         *
         * Enveloppé : depuis Android 12, démarrer un service de premier plan
         * depuis l'arrière-plan est refusé hors des cas exemptés, et MIUI est
         * plus restrictif encore. Un refus ne doit pas faire tomber
         * l'application — l'utilisateur ouvrira l'écran de gestion, qui le lui
         * dira.
         */
        fun start(context: Context) {
            val intent = Intent(context, WorkerForegroundService::class.java).setAction(ACTION_START)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (error: Exception) {
                // Aucun détail dans le journal : le message d'Android peut citer
                // le paquet et l'état du processus, et ce journal est lisible par
                // `adb logcat`.
                Log.w(TAG, "service de premier plan refuse par le systeme")
            }
        }
    }

    /**
     * Aucun canal de liaison.
     *
     * C'est la garantie structurelle que ce service ne devient pas un second
     * chemin d'exécution : rien ne peut s'y lier, donc rien ne peut lui envoyer
     * d'ordre. Le seul chemin vers une capacité reste
     * cœur → `WorkerRuntime` → `LocalCapabilityRegistry` → politique → pont.
     */
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            // `null` arrive au redémarrage par le système après un START_STICKY.
            ACTION_START, null -> Unit
            else -> {
                // Une intention inconnue n'est pas interprétée. Elle ne peut
                // rien porter d'exécutable — il n'y a aucun champ à lire.
                Log.w(TAG, "intention ignoree")
                return START_STICKY
            }
        }

        startForeground(NOTIFICATION_ID, buildNotification())
        startJavaScriptRuntime()

        // Le système relance le service s'il le tue faute de mémoire. Sur MIUI,
        // cela ne suffit pas : il faut aussi que l'utilisateur ait accordé
        // l'autostart et retiré la restriction de batterie. Le README le dit.
        return START_STICKY
    }

    /**
     * Démarre le moteur JavaScript s'il ne tourne pas déjà.
     *
     * C'est tout ce que ce service fait au worker : il l'allume. Ce qui suit —
     * configuration, capacités, poignée de main, exécution — se passe dans le
     * JavaScript, dans le code partagé et testé.
     */
    private fun startJavaScriptRuntime() {
        val host = (application as? ReactApplication)?.reactNativeHost ?: return
        if (host.hasInstance()) return

        try {
            host.reactInstanceManager.createReactContextInBackground()
        } catch (error: Exception) {
            Log.e(TAG, "demarrage du moteur JavaScript impossible")
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()

        // Toucher la notification ouvre l'écran de gestion. C'est le seul geste
        // qu'elle propose : elle n'offre aucune action de commande.
        val open = Intent(this, WorkerActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.foreground_service_text))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(pending)
            .setOngoing(true)
            // Aucun contenu de tâche n'est affiché : le titre d'une tâche peut
            // contenir un nom, une adresse, un fichier — et une notification
            // s'affiche sur un écran verrouillé.
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.foreground_service_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    @Suppress("DEPRECATION")
    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            stopForeground(true)
        }
    }
}
