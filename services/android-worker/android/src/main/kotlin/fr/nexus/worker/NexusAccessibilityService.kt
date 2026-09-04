package fr.nexus.worker

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.Executors
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Service d'accessibilité NEXUS.
 *
 * C'est le seul mécanisme légitime d'Android pour agir sur l'interface d'une
 * autre application, et il ne peut être activé que par l'utilisateur, depuis
 * Réglages → Accessibilité. Aucune API ne permet de l'activer par programme, et
 * ce service ne cherche pas à contourner cette règle.
 *
 * Trois principes tenus dans tout ce fichier :
 *
 *  1. **Rien n'est collecté.** `onAccessibilityEvent` ne fait rien. Le service
 *     ne lit la hiérarchie de vues qu'au moment où une tâche le demande, agit,
 *     et n'en conserve aucune trace.
 *  2. **Rien n'est enregistré en continu.** La capture est ponctuelle, sur
 *     appel, et l'API utilisée ne permet structurellement pas un flux vidéo.
 *  3. **Aucune décision n'est prise ici.** La validation, les politiques et les
 *     permissions ont déjà été appliquées côté TypeScript, dans du code
 *     testable. Ce service exécute ce qu'on lui demande, ou échoue.
 */
class NexusAccessibilityService : AccessibilityService() {

    companion object {
        /**
         * Instance courante, ou `null` si l'utilisateur n'a pas activé le service.
         *
         * C'est cette référence que consulte `isAccessibilityEnabled()` : elle
         * dit l'état réel, ici et maintenant, et non ce qui était vrai au
         * démarrage.
         */
        @Volatile
        var instance: NexusAccessibilityService? = null
            private set

        val isRunning: Boolean
            get() = instance != null
    }

    private val screenshotExecutor = Executors.newSingleThreadExecutor()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        instance = null
        screenshotExecutor.shutdown()
        super.onDestroy()
    }

    /**
     * Aucun traitement.
     *
     * Le service est déclaré sur `typeWindowStateChanged` uniquement, et n'en
     * fait rien : il n'observe pas ce que l'utilisateur fait. Le corps vide
     * n'est pas un oubli — c'est la garantie qu'aucune donnée d'interface n'est
     * collectée en dehors d'une tâche explicite.
     */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    // ── Recherche d'éléments ────────────────────────────────────────────────

    /**
     * Résout un sélecteur en nœud de l'écran actif.
     *
     * Renvoie `null` si rien ne correspond — cas parfaitement ordinaire quand
     * l'écran a changé entre la décision et l'action.
     */
    fun findNode(selector: UiSelector): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null

        return when (selector) {
            is UiSelector.ViewId ->
                root.findAccessibilityNodeInfosByViewId(selector.value).firstOrNull()

            is UiSelector.Text ->
                root.findAccessibilityNodeInfosByText(selector.value)
                    .firstOrNull { it.text?.toString() == selector.value }
                    ?: root.findAccessibilityNodeInfosByText(selector.value).firstOrNull()

            is UiSelector.ContentDescription -> findByContentDescription(root, selector.value)

            // Un appui par coordonnées ne passe par aucun nœud : c'est
            // précisément ce qui le rend risqué, et pourquoi la politique le
            // refuse par défaut.
            is UiSelector.Coordinates -> null
        }
    }

    private fun findByContentDescription(
        node: AccessibilityNodeInfo,
        description: String,
    ): AccessibilityNodeInfo? {
        if (node.contentDescription?.toString() == description) return node

        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            findByContentDescription(child, description)?.let { return it }
        }
        return null
    }

    /** Décrit un nœud pour le côté TypeScript, sans rien conserver. */
    fun describe(node: AccessibilityNodeInfo): Map<String, Any?> {
        val bounds = android.graphics.Rect().also { node.getBoundsInScreen(it) }

        return mapOf(
            "viewId" to node.viewIdResourceName,
            "text" to node.text?.toString(),
            "contentDescription" to node.contentDescription?.toString(),
            "className" to node.className?.toString(),
            "clickable" to node.isClickable,
            "editable" to node.isEditable,
            "scrollable" to node.isScrollable,
            "bounds" to mapOf(
                "left" to bounds.left,
                "top" to bounds.top,
                "right" to bounds.right,
                "bottom" to bounds.bottom,
            ),
        )
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /**
     * Appuie sur un élément.
     *
     * Remonte au premier ancêtre cliquable si le nœud trouvé ne l'est pas
     * lui-même : un libellé à l'intérieur d'un bouton est le cas le plus
     * courant. La politique a déjà vérifié que la cible accepte un clic.
     */
    fun performClick(selector: UiSelector): Boolean {
        if (selector is UiSelector.Coordinates) {
            return dispatchTap(selector.x.toFloat(), selector.y.toFloat())
        }

        var node = findNode(selector) ?: return false
        while (!node.isClickable) {
            node = node.parent ?: return false
        }

        return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    /**
     * Saisit du texte dans un champ.
     *
     * `ACTION_SET_TEXT` remplace le contenu au lieu de simuler des frappes :
     * c'est plus fiable, et surtout cela ne passe pas par le clavier, donc le
     * texte n'est pas soumis à la correction automatique ni enregistré dans le
     * dictionnaire personnel de l'utilisateur.
     *
     * **Le texte n'est jamais journalisé ici, ni ailleurs.**
     */
    fun performInput(selector: UiSelector, text: String): Boolean {
        var node = findNode(selector) ?: return false
        while (!node.isEditable) {
            node = node.parent ?: return false
        }

        val arguments = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
    }

    /**
     * Fait défiler l'écran.
     *
     * On privilégie l'action d'accessibilité d'un conteneur défilant, qui
     * respecte la sémantique de l'application. Le geste tactile n'est utilisé
     * qu'à défaut, et pour les directions horizontales que l'action ne couvre
     * pas toujours.
     */
    fun performScroll(direction: String, amount: Int): Boolean {
        val root = rootInActiveWindow ?: return false
        val scrollable = findScrollable(root)

        var succeeded = false
        repeat(amount.coerceIn(1, 20)) {
            succeeded = when {
                scrollable != null && direction == "down" ->
                    scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)

                scrollable != null && direction == "up" ->
                    scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)

                else -> dispatchSwipe(direction)
            } || succeeded
        }

        return succeeded
    }

    private fun findScrollable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isScrollable) return node

        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            findScrollable(child)?.let { return it }
        }
        return null
    }

    // ── Gestes ──────────────────────────────────────────────────────────────

    private fun dispatchTap(x: Float, y: Float): Boolean {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    private fun dispatchSwipe(direction: String): Boolean {
        val metrics = resources.displayMetrics
        val centerX = metrics.widthPixels / 2f
        val centerY = metrics.heightPixels / 2f
        val distanceY = metrics.heightPixels / 4f
        val distanceX = metrics.widthPixels / 4f

        val path = Path()
        when (direction) {
            "down" -> {
                path.moveTo(centerX, centerY + distanceY)
                path.lineTo(centerX, centerY - distanceY)
            }
            "up" -> {
                path.moveTo(centerX, centerY - distanceY)
                path.lineTo(centerX, centerY + distanceY)
            }
            "left" -> {
                path.moveTo(centerX + distanceX, centerY)
                path.lineTo(centerX - distanceX, centerY)
            }
            "right" -> {
                path.moveTo(centerX - distanceX, centerY)
                path.lineTo(centerX + distanceX, centerY)
            }
            else -> return false
        }

        val stroke = GestureDescription.StrokeDescription(path, 0, 300)
        return dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    // ── Capture d'écran ─────────────────────────────────────────────────────

    /**
     * Capture l'écran, une fois.
     *
     * `takeScreenshot()` (Android 11+) est le mécanisme de **moindre privilège** :
     * aucune permission au-delà du service d'accessibilité déjà activé, aucun
     * dialogue système supplémentaire, aucun jeton persistant — et surtout, une
     * image par appel. `MediaProjection` ouvrirait un flux vidéo continu là où
     * une image suffit.
     *
     * L'image est redimensionnée et encodée en mémoire ; **aucun fichier n'est
     * écrit**. Le bitmap est recyclé immédiatement après l'encodage.
     */
    suspend fun takeScreenshotBase64(maxDimension: Int): NexusScreenshot? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null

        return suspendCancellableCoroutine { continuation ->
            takeScreenshot(
                android.view.Display.DEFAULT_DISPLAY,
                screenshotExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                        // Le système rend un tampon MATÉRIEL, pas une image. Il est
                        // refermé dès la copie faite : un `HardwareBuffer` laissé
                        // ouvert retient de la mémoire graphique que le ramasse-
                        // miettes ne libère pas.
                        val buffer = screenshot.hardwareBuffer
                        val materiel = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                        buffer.close()

                        if (materiel == null) {
                            continuation.resume(null)
                            return
                        }

                        // Copie logicielle : un bitmap matériel ne peut être ni
                        // redimensionné ni relu pixel par pixel.
                        val bitmap = materiel.copy(Bitmap.Config.ARGB_8888, false)
                        materiel.recycle()

                        if (bitmap == null) {
                            continuation.resume(null)
                            return
                        }

                        val scaled = downscale(bitmap, maxDimension)
                        val encoded = encodePng(scaled)

                        // Les tampons sont libérés tout de suite : une image
                        // d'écran retenue en mémoire est une fuite qui dure.
                        if (scaled !== bitmap) scaled.recycle()
                        bitmap.recycle()

                        continuation.resume(encoded)
                    }

                    override fun onFailure(errorCode: Int) {
                        continuation.resume(null)
                    }
                },
            )
        }
    }

    private fun downscale(bitmap: Bitmap, maxDimension: Int): Bitmap {
        val largest = maxOf(bitmap.width, bitmap.height)
        if (largest <= maxDimension) return bitmap

        val ratio = maxDimension.toFloat() / largest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * ratio).toInt(),
            (bitmap.height * ratio).toInt(),
            true,
        )
    }

    private fun encodePng(bitmap: Bitmap): NexusScreenshot {
        val stream = java.io.ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        val bytes = stream.toByteArray()

        return NexusScreenshot(
            base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
            format = "png",
            width = bitmap.width,
            height = bitmap.height,
            bytes = bytes.size,
        )
    }
}

/**
 * Résultat d'une capture. Vit en mémoire, n'est jamais écrit sur disque.
 *
 * Le préfixe `Nexus` n'est pas cosmétique : `AccessibilityService` déclare son
 * propre type imbriqué `ScreenshotResult`, celui que le rappel système reçoit.
 * Deux types du même nom rendaient le nôtre inatteignable depuis l'intérieur du
 * service, où le type imbriqué l'emporte.
 */
data class NexusScreenshot(
    val base64: String,
    val format: String,
    val width: Int,
    val height: Int,
    val bytes: Int,
)

/**
 * Sélecteur d'élément d'interface.
 *
 * Miroir exact du type `UiSelector` côté TypeScript. L'ordre de préférence est
 * le même : identifiant de vue, puis texte, puis description, et les coordonnées
 * en dernier recours seulement.
 */
sealed interface UiSelector {
    data class ViewId(val value: String) : UiSelector
    data class Text(val value: String) : UiSelector
    data class ContentDescription(val value: String) : UiSelector
    data class Coordinates(val x: Int, val y: Int) : UiSelector

    companion object {
        /** Décode le JSON produit par `native-bridge.ts`. */
        fun fromJson(json: String): UiSelector? {
            val obj = org.json.JSONObject(json)
            return when (obj.optString("kind")) {
                "viewId" -> ViewId(obj.getString("value"))
                "text" -> Text(obj.getString("value"))
                "contentDescription" -> ContentDescription(obj.getString("value"))
                "coordinates" -> Coordinates(obj.getInt("x"), obj.getInt("y"))
                else -> null
            }
        }
    }
}
