package app.pairwise.nativebridge

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Writes received files into Downloads/Pairwise through MediaStore (no storage permission needed). */
object Downloads {
    private class Open(val uri: Uri, val out: OutputStream, val name: String)

    private val open = ConcurrentHashMap<String, Open>()

    fun begin(ctx: Context, name: String, mime: String): String {
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, safeName(name))
            put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
            put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/Pairwise")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("Couldn't create the file in Downloads")
        val out = resolver.openOutputStream(uri) ?: run {
            resolver.delete(uri, null, null)
            throw IllegalStateException("Couldn't open the file in Downloads")
        }
        val id = UUID.randomUUID().toString()
        open[id] = Open(uri, out.buffered(256 * 1024), name)
        return id
    }

    fun append(id: String, chunk: ByteArray) {
        val o = open[id] ?: throw IllegalStateException("Transfer already closed")
        o.out.write(chunk)
    }

    /** Publishes the file and returns a readable location for the app's activity list. */
    fun commit(ctx: Context, id: String): String {
        val o = open.remove(id) ?: throw IllegalStateException("Transfer already closed")
        o.out.close()
        ctx.contentResolver.update(o.uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        return o.uri.toString()
    }

    fun abort(ctx: Context, id: String) {
        val o = open.remove(id) ?: return
        runCatching { o.out.close() }
        runCatching { ctx.contentResolver.delete(o.uri, null, null) }
    }

    private fun safeName(name: String): String {
        val base = name.substringAfterLast('/').substringAfterLast('\\')
        val clean = base.replace(Regex("[\\u0000-\\u001f<>:\"|?*]"), "_").trim('.', ' ').take(200)
        return clean.ifBlank { "file" }
    }
}
