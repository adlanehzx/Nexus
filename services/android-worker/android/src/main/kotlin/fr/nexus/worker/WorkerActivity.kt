package fr.nexus.worker

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * Worker management activity.
 */
class WorkerActivity : ReactActivity() {

    override fun getMainComponentName(): String = "NexusWorker"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName ?: "NexusWorker", false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WorkerForegroundService.start(this)
    }
}
