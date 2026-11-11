package app.pairwise.nativebridge

import android.app.Activity
import android.app.PendingIntent
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.Toast
import java.io.File
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Android lets only the focused app read the clipboard, so "Send clipboard" briefly opens this
 * invisible activity, reads the clip once it has focus, hands it to JavaScript and closes.
 * Opened by the Quick Settings tile and the notification's action.
 */
class ClipSendActivity : Activity() {
    private var handled = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || handled) return
        handled = true
        val cm = getSystemService(ClipboardManager::class.java)
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        if (text.isNullOrEmpty()) {
            Toast.makeText(applicationContext, "Clipboard is empty", Toast.LENGTH_SHORT).show()
        } else {
            PairwiseEvents.emit("onClipboardCaptured", mapOf("text" to text))
            PairwiseEvents.ensureAppRunning(this)
        }
        finish()
    }
}

/** "Computer" in the share sheet: text goes to the computer's clipboard, files to its Downloads. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uris = streamUris(intent)
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        when {
            uris.isNotEmpty() -> {
                Toast.makeText(applicationContext, "Sending to your computer…", Toast.LENGTH_SHORT).show()
                // Copy now, while we hold the read grant; the send happens after this activity closes.
                // Open the app now if needed: Android blocks starting activities once we've closed.
                PairwiseEvents.ensureAppRunning(this)
                thread(name = "pairwise-share-copy") {
                    val files = uris.mapNotNull { copyToCache(it) }
                    if (files.isNotEmpty()) PairwiseEvents.emit("onShare", mapOf("kind" to "files", "files" to files))
                }
            }
            !text.isNullOrEmpty() -> {
                PairwiseEvents.emit("onShare", mapOf("kind" to "text", "text" to text))
                PairwiseEvents.ensureAppRunning(this)
            }
            else -> Toast.makeText(this, "Nothing to send", Toast.LENGTH_SHORT).show()
        }
        finish()
    }

    private fun copyToCache(uri: Uri): Map<String, Any?>? = runCatching {
        var name = "file"
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
        }
        val safe = name.substringAfterLast('/').ifBlank { "file" }
        val dir = File(cacheDir, "shared/${UUID.randomUUID()}").apply { mkdirs() }
        val dest = File(dir, safe)
        contentResolver.openInputStream(uri)!!.use { input -> dest.outputStream().use { input.copyTo(it, 256 * 1024) } }
        mapOf("uri" to Uri.fromFile(dest).toString(), "name" to safe, "size" to dest.length().toDouble(), "mime" to contentResolver.getType(uri))
    }.getOrNull()

    @Suppress("DEPRECATION")
    private fun streamUris(intent: Intent): List<Uri> = when (intent.action) {
        Intent.ACTION_SEND -> listOfNotNull(
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM),
        )
        Intent.ACTION_SEND_MULTIPLE ->
            (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
        else -> emptyList()
    }
}

/** Quick Settings tile: one tap sends the phone's clipboard to the computer. */
class ClipTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_INACTIVE
            label = "Send to computer"
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        val intent = Intent(this, ClipSendActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
