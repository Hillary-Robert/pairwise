package app.pairwise.nativebridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.OpenableColumns
import android.provider.Settings
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.RandomAccessFile
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

class PairwiseNativeModule : Module() {
    private val context: Context get() = requireNotNull(appContext.reactContext) { "React context is gone" }

    fun emit(name: String, body: Map<String, Any?>) = sendEvent(name, body)

    override fun definition() = ModuleDefinition {
        Name("PairwiseNative")
        Events("onShare", "onClipboardCaptured", "onTick", "onNetwork")

        OnCreate { PairwiseEvents.attach(this@PairwiseNativeModule) }
        OnDestroy { PairwiseEvents.detach(this@PairwiseNativeModule) }
        OnStartObserving { PairwiseEvents.observing = true }
        OnStopObserving { PairwiseEvents.observing = false }

        Function("drainPending") { PairwiseEvents.drain() }

        Function("deviceName") {
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
                ?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}"
        }

        Function("startService") { title: String, text: String -> PairwiseLinkService.start(context, title, text) }
        Function("stopService") { PairwiseLinkService.stop(context) }

        Function("isIgnoringBatteryOptimizations") {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(context.packageName)
        }

        Function("requestIgnoreBatteryOptimizations") {
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(i)
        }

        /** Broadcasts [payload] on every IPv4 network and collects replies until the timeout. */
        AsyncFunction("probe") { payload: ByteArray, port: Int, timeoutMs: Int ->
            val replies = mutableListOf<Map<String, String>>()
            DatagramSocket().use { sock ->
                sock.broadcast = true
                for (target in broadcastTargets()) {
                    runCatching { sock.send(DatagramPacket(payload, payload.size, target, port)) }
                }
                val deadline = System.currentTimeMillis() + timeoutMs
                val buf = ByteArray(2048)
                while (true) {
                    val left = deadline - System.currentTimeMillis()
                    if (left <= 0) break
                    sock.soTimeout = left.toInt().coerceAtLeast(1)
                    try {
                        val p = DatagramPacket(buf, buf.size)
                        sock.receive(p)
                        replies += mapOf(
                            "host" to (p.address.hostAddress ?: continue),
                            "reply" to String(p.data, 0, p.length, Charsets.UTF_8),
                        )
                    } catch (_: SocketTimeoutException) {
                        break
                    }
                }
            }
            replies
        }

        AsyncFunction("scanQr") { promise: Promise ->
            val activity = appContext.currentActivity
            if (activity == null) {
                promise.reject("E_NO_ACTIVITY", "Open the app to scan", null)
                return@AsyncFunction
            }
            val options = GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
            GmsBarcodeScanning.getClient(activity, options).startScan()
                .addOnSuccessListener { promise.resolve(it.rawValue ?: "") }
                .addOnCanceledListener { promise.resolve(null) }
                .addOnFailureListener { promise.reject("E_SCAN", it.message ?: "Scanner unavailable", it) }
        }.runOnQueue(Queues.MAIN)

        Function("beginDownload") { name: String, mime: String -> Downloads.begin(context, name, mime) }
        AsyncFunction("appendDownload") { id: String, chunk: ByteArray -> Downloads.append(id, chunk) }
        AsyncFunction("commitDownload") { id: String -> Downloads.commit(context, id) }
        AsyncFunction("abortDownload") { id: String -> Downloads.abort(context, id) }

        AsyncFunction("fileInfo") { uri: String -> fileInfo(uri) }

        AsyncFunction("readChunk") { uri: String, offset: Double, length: Int ->
            readChunk(uri, offset.toLong(), length)
        }

        AsyncFunction("deleteFile") { uri: String ->
            if (uri.startsWith("file://") || uri.startsWith("/")) File(Uri.parse(uri).path ?: uri).delete()
        }
    }

    private fun broadcastTargets(): List<InetAddress> {
        val out = mutableListOf<InetAddress>()
        runCatching {
            for (ni in NetworkInterface.getNetworkInterfaces()) {
                if (!ni.isUp || ni.isLoopback) continue
                for (ia in ni.interfaceAddresses) {
                    if (ia.address is Inet4Address) ia.broadcast?.let { out += it }
                }
            }
        }
        out += InetAddress.getByName("255.255.255.255")
        return out.distinct()
    }

    private fun fileInfo(uri: String): Map<String, Any?> {
        val u = Uri.parse(uri)
        if (u.scheme == "content") {
            context.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    return mapOf(
                        "name" to c.getString(0),
                        "size" to (if (c.isNull(1)) -1.0 else c.getLong(1).toDouble()),
                        "mime" to context.contentResolver.getType(u),
                    )
                }
            }
            return mapOf("name" to "file", "size" to -1.0, "mime" to context.contentResolver.getType(u))
        }
        val f = File(u.path ?: uri)
        return mapOf("name" to f.name, "size" to f.length().toDouble(), "mime" to null)
    }

    private fun readChunk(uri: String, offset: Long, length: Int): ByteArray {
        val u = Uri.parse(uri)
        val buf = ByteArray(length)
        val n = if (u.scheme == "content") {
            context.contentResolver.openFileDescriptor(u, "r")!!.use { pfd ->
                FileInputStream(pfd.fileDescriptor).use { s ->
                    s.channel.position(offset)
                    readFully(s, buf)
                }
            }
        } else {
            RandomAccessFile(File(u.path ?: uri), "r").use { raf ->
                raf.seek(offset)
                var total = 0
                while (total < length) {
                    val r = raf.read(buf, total, length - total)
                    if (r < 0) break
                    total += r
                }
                total
            }
        }
        return if (n == length) buf else buf.copyOf(maxOf(n, 0))
    }

    private fun readFully(s: FileInputStream, buf: ByteArray): Int {
        var total = 0
        while (total < buf.size) {
            val r = s.read(buf, total, buf.size - total)
            if (r < 0) break
            total += r
        }
        return total
    }
}
