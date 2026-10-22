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
 * NEXUS Accessibility Service.
 *
 * This is Android's legitimate mechanism to interact with the UI of another
 * application, enabled only by the user in Settings → Accessibility.
 */
class NexusAccessibilityService : AccessibilityService() {

    companion object {
        /**
         * Current instance, or `null` if the user has not enabled the service.
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
     * No background collection.
     */
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    // ── Element Search ──────────────────────────────────────────────────────

    /**
     * Resolves a selector to a node in the active window.
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

    /** Describes a node for TypeScript without retaining any reference. */
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
     * Taps an element.
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
     * Inputs text into a field.
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
     * Scrolls the screen.
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

    // ── Gestures ────────────────────────────────────────────────────────────

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

    // ── Screenshots ─────────────────────────────────────────────────────────

    /**
     * Captures screen on demand.
     */
    suspend fun takeScreenshotBase64(maxDimension: Int): NexusScreenshot? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null

        return suspendCancellableCoroutine { continuation ->
            takeScreenshot(
                android.view.Display.DEFAULT_DISPLAY,
                screenshotExecutor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: AccessibilityService.ScreenshotResult) {
                        val buffer = screenshot.hardwareBuffer
                        val hardwareBitmap = Bitmap.wrapHardwareBuffer(buffer, screenshot.colorSpace)
                        buffer.close()

                        if (hardwareBitmap == null) {
                            continuation.resume(null)
                            return
                        }

                        val bitmap = hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false)
                        hardwareBitmap.recycle()

                        if (bitmap == null) {
                            continuation.resume(null)
                            return
                        }

                        val scaled = downscale(bitmap, maxDimension)
                        val encoded = encodePng(scaled)

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
 * Screenshot result kept in memory, never written to disk.
 */
data class NexusScreenshot(
    val base64: String,
    val format: String,
    val width: Int,
    val height: Int,
    val bytes: Int,
)

/**
 * UI element selector.
 */
sealed interface UiSelector {
    data class ViewId(val value: String) : UiSelector
    data class Text(val value: String) : UiSelector
    data class ContentDescription(val value: String) : UiSelector
    data class Coordinates(val x: Int, val y: Int) : UiSelector

    companion object {
        /** Decodes JSON produced by `native-bridge.ts`. */
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
