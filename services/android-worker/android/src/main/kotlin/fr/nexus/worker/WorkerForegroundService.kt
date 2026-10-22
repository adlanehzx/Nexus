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
 * Foreground service: maintains the worker process alive.
 */
class WorkerForegroundService : Service() {

    companion object {
        private const val TAG = "NexusWorker"

        /** The only two recognized actions. */
        const val ACTION_START = "fr.nexus.worker.action.START"
        const val ACTION_STOP = "fr.nexus.worker.action.STOP"

        private const val CHANNEL_ID = "nexus.worker.connection"
        private const val NOTIFICATION_ID = 42

        /**
         * Starts the service from the application.
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
                Log.w(TAG, "foreground service refused by system")
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> Unit
            else -> {
                Log.w(TAG, "ignored intent")
                return START_STICKY
            }
        }

        startForeground(NOTIFICATION_ID, buildNotification())
        startJavaScriptRuntime()

        return START_STICKY
    }

    private fun startJavaScriptRuntime() {
        val host = (application as? ReactApplication)?.reactNativeHost ?: return
        if (host.hasInstance()) return

        try {
            host.reactInstanceManager.createReactContextInBackground()
        } catch (error: Exception) {
            Log.e(TAG, "starting JavaScript runtime failed")
        }
    }

    private fun buildNotification(): Notification {
        ensureChannel()

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
