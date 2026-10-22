package fr.nexus.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restarts worker after device reboot.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        WorkerForegroundService.start(context.applicationContext)
    }
}
