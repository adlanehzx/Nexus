package fr.nexus.worker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Bridge between TypeScript worker and Android system.
 *
 * Each `@ReactMethod` below is an explicit capability granted to JavaScript code.
 * Validation, policies, and permissions are handled on the TypeScript side.
 */
class NexusWorkerModule(private val context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

    companion object {
        const val NAME = "NexusWorker"
        const val CHANNEL_ID = "nexus.tasks"
        private const val KEYSTORE = "AndroidKeyStore"
    }

    private val scope = CoroutineScope(Dispatchers.Default)
    private var notificationCounter = 1

    private val secureRandom = java.security.SecureRandom()

    override fun getName() = NAME

    // ── Applications ────────────────────────────────────────────────────────

    /**
     * Launchable applications visible to the worker.
     */
    @ReactMethod
    fun listApps(promise: Promise) {
        try {
            val manager = context.packageManager
            val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val activities = manager.queryIntentActivities(intent, 0)

            val apps = Arguments.createArray()
            for (resolved in activities) {
                val info = resolved.activityInfo ?: continue
                val entry = Arguments.createMap().apply {
                    putString("packageName", info.packageName)
                    putString("label", resolved.loadLabel(manager).toString())
                    putBoolean("launchable", true)
                }
                apps.pushMap(entry)
            }

            promise.resolve(apps)
        } catch (error: Exception) {
            promise.reject("LIST_APPS_FAILED", error.message, error)
        }
    }

    @ReactMethod
    fun isInstalled(packageName: String, promise: Promise) {
        promise.resolve(launchIntentFor(packageName) != null)
    }

    /**
     * Requests opening an application.
     */
    @ReactMethod
    fun openApp(packageName: String, promise: Promise) {
        val intent = launchIntentFor(packageName)
        if (intent == null) {
            promise.resolve(result(launched = false, reason = "no launch activity"))
            return
        }

        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            promise.resolve(result(launched = true))
        } catch (error: SecurityException) {
            promise.resolve(result(launched = false, reason = "background activity start blocked"))
        } catch (error: Exception) {
            promise.resolve(result(launched = false, reason = error.javaClass.simpleName))
        }
    }

    private fun launchIntentFor(packageName: String): Intent? =
        try {
            context.packageManager.getLaunchIntentForPackage(packageName)
        } catch (error: PackageManager.NameNotFoundException) {
            null
        }

    private fun result(launched: Boolean, reason: String? = null): WritableMap =
        Arguments.createMap().apply {
            putBoolean("launched", launched)
            if (reason != null) putString("reason", reason)
        }

    // ── Accessibility ───────────────────────────────────────────────────────

    /**
     * Checks if accessibility service is currently enabled.
     */
    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        promise.resolve(NexusAccessibilityService.isRunning)
    }

    @ReactMethod
    fun findNode(selectorJson: String, promise: Promise) {
        val service = NexusAccessibilityService.instance
        val selector = UiSelector.fromJson(selectorJson)

        if (service == null || selector == null) {
            promise.resolve(null)
            return
        }

        val node = service.findNode(selector)
        promise.resolve(if (node == null) null else Arguments.makeNativeMap(service.describe(node)))
    }

    @ReactMethod
    fun click(selectorJson: String, promise: Promise) {
        val service = NexusAccessibilityService.instance
        val selector = UiSelector.fromJson(selectorJson)

        if (service == null) {
            promise.reject("ACCESSIBILITY_DISABLED", "accessibility service disabled")
            return
        }
        if (selector == null) {
            promise.reject("INVALID_SELECTOR", "unreadable selector")
            return
        }

        val clicked = service.performClick(selector)
        promise.resolve(Arguments.createMap().apply { putBoolean("clicked", clicked) })
    }

    /**
     * Inputs text.
     */
    @ReactMethod
    fun inputText(selectorJson: String, text: String, promise: Promise) {
        val service = NexusAccessibilityService.instance
        val selector = UiSelector.fromJson(selectorJson)

        if (service == null) {
            promise.reject("ACCESSIBILITY_DISABLED", "accessibility service disabled")
            return
        }
        if (selector == null) {
            promise.reject("INVALID_SELECTOR", "unreadable selector")
            return
        }

        val entered = service.performInput(selector, text)
        promise.resolve(
            Arguments.createMap().apply {
                putBoolean("entered", entered)
                putInt("characters", text.length)
            },
        )
    }

    @ReactMethod
    fun scroll(direction: String, amount: Int, promise: Promise) {
        val service = NexusAccessibilityService.instance
        if (service == null) {
            promise.reject("ACCESSIBILITY_DISABLED", "accessibility service disabled")
            return
        }

        val scrolled = service.performScroll(direction, amount)
        promise.resolve(Arguments.createMap().apply { putBoolean("scrolled", scrolled) })
    }

    // ── Screenshot ──────────────────────────────────────────────────────────

    /**
     * Checks if screenshot capability is available.
     */
    @ReactMethod
    fun isScreenshotAvailable(promise: Promise) {
        promise.resolve(
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && NexusAccessibilityService.isRunning,
        )
    }

    @ReactMethod
    fun takeScreenshot(maxDimension: Int, promise: Promise) {
        val service = NexusAccessibilityService.instance
        if (service == null) {
            promise.reject("ACCESSIBILITY_DISABLED", "accessibility service disabled")
            return
        }

        scope.launch {
            val shot = service.takeScreenshotBase64(maxDimension)
            if (shot == null) {
                promise.reject("SCREENSHOT_FAILED", "screenshot failed")
                return@launch
            }

            promise.resolve(
                Arguments.createMap().apply {
                    putString("base64", shot.base64)
                    putString("format", shot.format)
                    putInt("width", shot.width)
                    putInt("height", shot.height)
                    putInt("bytes", shot.bytes)
                },
            )
        }
    }

    // ── Notifications ───────────────────────────────────────────────────────

    /**
     * Send notifications only.
     */
    @ReactMethod
    fun canPostNotifications(promise: Promise) {
        promise.resolve(NotificationManagerCompat.from(context).areNotificationsEnabled())
    }

    @ReactMethod
    fun postNotification(title: String, body: String, channelId: String, promise: Promise) {
        try {
            ensureChannel()

            val notification = NotificationCompat.Builder(context, channelId)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setAutoCancel(true)
                .build()

            val id = notificationCounter++
            NotificationManagerCompat.from(context).notify(id, notification)

            promise.resolve(
                Arguments.createMap().apply {
                    putBoolean("posted", true)
                    putInt("notificationId", id)
                },
            )
        } catch (error: SecurityException) {
            promise.reject("NOTIFICATION_DENIED", "notification permission denied")
        } catch (error: Exception) {
            promise.reject("NOTIFICATION_FAILED", error.javaClass.simpleName, error)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "NEXUS", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    // ── Device State ────────────────────────────────────────────────────────

    /**
     * Battery and power save mode.
     */
    @ReactMethod
    fun batteryState(promise: Promise) {
        val manager = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager

        promise.resolve(
            Arguments.createMap().apply {
                putInt("percent", manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
                putBoolean("charging", manager.isCharging)
                putBoolean("powerSaveMode", power.isPowerSaveMode)
            },
        )
    }

    @ReactMethod
    fun sdkVersion(promise: Promise) {
        promise.resolve(Build.VERSION.SDK_INT)
    }

    // ── Signing ─────────────────────────────────────────────────────────────

    /**
     * Signs authentication challenge.
     *
     * Private key never leaves Android KeyStore.
     */
    @ReactMethod
    fun signChallenge(keyAlias: String, nonce: String, promise: Promise) {
        try {
            val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            val entry = store.getEntry(keyAlias, null) as? KeyStore.PrivateKeyEntry
                ?: run {
                    generateKey(keyAlias)
                    (KeyStore.getInstance(KEYSTORE).apply { load(null) }
                        .getEntry(keyAlias, null) as KeyStore.PrivateKeyEntry)
                }

            val signature = Signature.getInstance("SHA256withECDSA").apply {
                initSign(entry.privateKey)
                update(nonce.toByteArray(Charsets.UTF_8))
            }

            promise.resolve(
                android.util.Base64.encodeToString(
                    signature.sign(),
                    android.util.Base64.NO_WRAP,
                ),
            )
        } catch (error: Exception) {
            promise.reject("SIGN_FAILED", "signature failed")
        }
    }

    /**
     * Creates device key once.
     */
    private fun generateKey(alias: String) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        generator.generateKeyPair()
    }

    // ── Randomness ──────────────────────────────────────────────────────────

    /**
     * Cryptographic random bytes.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun secureRandomBase64(count: Int): String {
        val size = count.coerceIn(1, 1_024)
        val bytes = ByteArray(size)
        secureRandom.nextBytes(bytes)
        return android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
    }

    /** Public key of device, provided to core during pairing. */
    @ReactMethod
    fun devicePublicKeyPem(keyAlias: String, promise: Promise) {
        try {
            val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            if (store.getCertificate(keyAlias) == null) generateKey(keyAlias)

            val encoded = KeyStore.getInstance(KEYSTORE).apply { load(null) }
                .getCertificate(keyAlias).publicKey.encoded
            val base64 = android.util.Base64.encodeToString(encoded, android.util.Base64.NO_WRAP)

            promise.resolve(
                "-----BEGIN PUBLIC KEY-----\n" +
                    base64.chunked(64).joinToString("\n") +
                    "\n-----END PUBLIC KEY-----\n",
            )
        } catch (error: Exception) {
            promise.reject("PUBLIC_KEY_FAILED", "public key unavailable")
        }
    }

    /** Loads persisted public provisioning values. */
    @ReactMethod
    fun loadProvisioning(promise: Promise) {
        val preferences = context.getSharedPreferences("nexus-worker", Context.MODE_PRIVATE)
        val apiUrl = preferences.getString("apiUrl", null)
        val deviceId = preferences.getString("deviceId", null)
        if (apiUrl == null || deviceId == null) {
            promise.resolve(null)
            return
        }
        promise.resolve(Arguments.createMap().apply {
            putString("apiUrl", apiUrl)
            putString("deviceId", deviceId)
        })
    }

    /**
     * Persists public address and device ID. Token is never persisted and private
     * key remains in Android Keystore.
     */
    @ReactMethod
    fun saveProvisioning(apiUrl: String, deviceId: String, promise: Promise) {
        context.getSharedPreferences("nexus-worker", Context.MODE_PRIVATE)
            .edit()
            .putString("apiUrl", apiUrl)
            .putString("deviceId", deviceId)
            .apply()
        promise.resolve(null)
    }
}
