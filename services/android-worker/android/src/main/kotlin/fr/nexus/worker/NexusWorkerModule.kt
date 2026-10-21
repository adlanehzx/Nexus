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
 * Pont entre le worker TypeScript et le système Android.
 *
 * **Ce fichier est la surface d'attaque du worker, et elle est énumérable.**
 * Chaque `@ReactMethod` ci-dessous est un pouvoir accordé au code JavaScript ;
 * il n'y a pas de méthode générique, pas d'`invoke(nom, args)`, pas d'exécution
 * d'`Intent` arbitraire. Ajouter un pouvoir exige d'ajouter une méthode ici
 * *et* dans `native-bridge.ts`, ce qui se voit en revue.
 *
 * Aucune décision n'est prise ici : validation, politiques et permissions ont
 * déjà été appliquées côté TypeScript, dans du code testable. Ce module traduit
 * et appelle.
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

    // Une seule instance : `SecureRandom` s'auto-réensemence, et en construire
    // une par appel coute cher sans rien ajouter.
    private val secureRandom = java.security.SecureRandom()

    override fun getName() = NAME

    // ── Applications ────────────────────────────────────────────────────────

    /**
     * Applications lançables visibles du worker.
     *
     * La visibilité est filtrée par le `<queries>` du manifeste : on voit les
     * applications ouvrables, et rien d'autre. `QUERY_ALL_PACKAGES` n'est pas
     * demandé — il donnerait l'inventaire logiciel complet, qui en dit long sur
     * le propriétaire du téléphone.
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
     * Demande l'ouverture d'une application.
     *
     * Le système choisit lui-même l'activité de lancement : le JavaScript ne
     * fournit qu'un nom de paquet, jamais un composant ni une URI.
     *
     * Depuis Android 10, une application en arrière-plan ne peut pas toujours
     * démarrer une activité. Le service d'accessibilité, lorsqu'il est actif,
     * lève cette restriction. Sur MIUI s'ajoute une autorisation propre au
     * constructeur — « Afficher les fenêtres contextuelles en arrière-plan » —
     * dont l'absence produit exactement ce refus.
     */
    @ReactMethod
    fun openApp(packageName: String, promise: Promise) {
        val intent = launchIntentFor(packageName)
        if (intent == null) {
            promise.resolve(result(launched = false, reason = "aucune activité de lancement"))
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

    // ── Accessibilité ───────────────────────────────────────────────────────

    /**
     * Le service est-il activé, ici et maintenant ?
     *
     * Consulté à chaque appel et non une fois au démarrage : l'utilisateur peut
     * le désactiver à tout moment, et c'est son droit le plus strict.
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
            promise.reject("ACCESSIBILITY_DISABLED", "service d'accessibilité inactif")
            return
        }
        if (selector == null) {
            promise.reject("INVALID_SELECTOR", "sélecteur illisible")
            return
        }

        val clicked = service.performClick(selector)
        promise.resolve(Arguments.createMap().apply { putBoolean("clicked", clicked) })
    }

    /**
     * Saisit du texte.
     *
     * `text` ne passe par aucun journal, ici ni ailleurs. Un message d'erreur ne
     * le recopie pas non plus : c'est le chemin normal d'un mot de passe.
     */
    @ReactMethod
    fun inputText(selectorJson: String, text: String, promise: Promise) {
        val service = NexusAccessibilityService.instance
        val selector = UiSelector.fromJson(selectorJson)

        if (service == null) {
            promise.reject("ACCESSIBILITY_DISABLED", "service d'accessibilité inactif")
            return
        }
        if (selector == null) {
            promise.reject("INVALID_SELECTOR", "sélecteur illisible")
            return
        }

        val entered = service.performInput(selector, text)
        promise.resolve(
            Arguments.createMap().apply {
                putBoolean("entered", entered)
                // La longueur, jamais le contenu.
                putInt("characters", text.length)
            },
        )
    }

    @ReactMethod
    fun scroll(direction: String, amount: Int, promise: Promise) {
        val service = NexusAccessibilityService.instance
        if (service == null) {
            promise.reject("ACCESSIBILITY_DISABLED", "service d'accessibilité inactif")
            return
        }

        val scrolled = service.performScroll(direction, amount)
        promise.resolve(Arguments.createMap().apply { putBoolean("scrolled", scrolled) })
    }

    // ── Capture d'écran ─────────────────────────────────────────────────────

    /**
     * La capture est-elle possible ?
     *
     * Deux conditions : Android 11 ou plus récent, et le service
     * d'accessibilité actif. En dessous d'Android 11, la capacité n'est
     * simplement pas annoncée — plutôt que de basculer sur `MediaProjection`,
     * qui ouvrirait un flux vidéo permanent pour un besoin ponctuel.
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
            promise.reject("ACCESSIBILITY_DISABLED", "service d'accessibilité inactif")
            return
        }

        scope.launch {
            val shot = service.takeScreenshotBase64(maxDimension)
            if (shot == null) {
                promise.reject("SCREENSHOT_FAILED", "capture impossible")
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
     * Émission seule.
     *
     * Il n'existe **aucune** méthode de lecture dans ce module, et le manifeste
     * ne déclare aucun `NotificationListenerService`. Lire les notifications
     * donnerait accès aux messages, aux codes à usage unique, aux alertes
     * bancaires — ce n'est pas nécessaire ici.
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
            promise.reject("NOTIFICATION_DENIED", "permission de notification refusée")
        } catch (error: Exception) {
            promise.reject("NOTIFICATION_FAILED", error.javaClass.simpleName, error)
        }
    }

    /**
     * Un seul canal, délibérément.
     *
     * L'utilisateur peut couper les notifications de NEXUS d'un geste, depuis
     * les réglages du système, sans démêler une arborescence de sous-canaux.
     */
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "NEXUS", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    // ── État de l'appareil ──────────────────────────────────────────────────

    /**
     * Batterie et mode d'économie d'énergie.
     *
     * Rien d'autre. Pas de position, pas d'opérateur, pas d'identifiant
     * matériel : un téléphone personnel n'a pas à se faire superviser pour
     * rendre service.
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

    // ── Signature ───────────────────────────────────────────────────────────

    /**
     * Signe le challenge d'authentification.
     *
     * **La clé privée ne quitte jamais le magasin de clés.** L'application ne la
     * lit pas — elle demande une signature, et le système la produit. Sur un
     * appareil doté d'un élément sécurisé, la clé n'est même pas extractible par
     * le système lui-même.
     *
     * La courbe est P-256 et non Ed25519 : **le magasin de clés d'Android ne
     * gère pas Ed25519.** Le choix se pose donc entre une clé Ed25519 logicielle,
     * lisible par quiconque obtient les fichiers de l'application, et une clé
     * P-256 adossée au matériel. On préfère la résistance à l'extraction à
     * l'uniformité avec les autres appareils — le cœur sait vérifier les deux.
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
            // Le message technique reste local : il peut nommer l'alias, le
            // fournisseur, l'état du magasin.
            promise.reject("SIGN_FAILED", "signature impossible")
        }
    }

    /**
     * Crée la clé de l'appareil, une fois.
     *
     * `setUserAuthenticationRequired(false)` est délibéré : le worker doit
     * pouvoir se reconnecter quand l'écran est verrouillé, sinon il disparaît
     * du registre chaque nuit. La protection repose sur la non-extractibilité de
     * la clé, pas sur une authentification à chaque signature.
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

    // ── Aléa ─────────────────────────────────────────────────────────────

    /**
     * Octets aléatoires cryptographiques.
     *
     * **Pourquoi cette méthode existe.** Le moteur JavaScript de React Native
     * n'expose ni `crypto.getRandomValues`, ni le module `node:crypto`. Le code
     * partagé de NEXUS, lui, en a besoin : `uuidv7()` tire quatre-vingts bits
     * d'aléa par identifiant. Sans source sûre, il faudrait se rabattre sur
     * `Math.random`, dont la suite est prévisible à partir de quelques
     * observations.
     *
     * **Pourquoi elle est synchrone.** `randomFillSync` l'est, et le pont React
     * Native est asynchrone par défaut. Un appel bloquant est ici acceptable :
     * `SecureRandom.nextBytes` sur quelques dizaines d'octets se compte en
     * microsecondes, et l'alternative serait de réécrire une fonction du paquet
     * partagé pour une seule plateforme.
     *
     * **Ce qu'elle ne fait pas.** Elle ne touche pas au téléphone : elle ne lit
     * rien, n'affiche rien, ne démarre rien. Elle n'élargit donc pas ce que
     * NEXUS peut faire à l'appareil, contrairement aux méthodes qui précèdent.
     */
    @ReactMethod(isBlockingSynchronousMethod = true)
    fun secureRandomBase64(count: Int): String {
        // Borné : un appel bloquant ne doit pas pouvoir demander un mégaoctet et
        // figer le fil JavaScript.
        val taille = count.coerceIn(1, 1_024)
        val octets = ByteArray(taille)
        secureRandom.nextBytes(octets)
        return android.util.Base64.encodeToString(octets, android.util.Base64.NO_WRAP)
    }

    /** Clé publique de l'appareil, à remettre au cœur lors de l'appairage. */
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
            promise.reject("PUBLIC_KEY_FAILED", "clé publique indisponible")
        }
    }

    /** Charge les deux valeurs publiques issues de l'appairage. */
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
     * Persiste uniquement l'adresse et l'identifiant publics. Le ticket n'est
     * jamais ecrit et la cle privee reste dans Android Keystore.
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
