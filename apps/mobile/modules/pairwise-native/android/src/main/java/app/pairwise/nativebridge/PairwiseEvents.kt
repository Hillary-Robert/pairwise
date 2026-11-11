package app.pairwise.nativebridge

import android.content.Context
import android.content.Intent

/**
 * Hands events from activities and the service to JavaScript. Shares and clipboard sends that
 * arrive before JavaScript is listening are queued and picked up with drainPending().
 */
object PairwiseEvents {
    @Volatile private var module: PairwiseNativeModule? = null
    @Volatile var observing = false
    private val pending = mutableListOf<Map<String, Any?>>()

    val jsReady: Boolean get() = module != null && observing

    fun attach(m: PairwiseNativeModule) { module = m }

    fun detach(m: PairwiseNativeModule) {
        if (module === m) {
            module = null
            observing = false
        }
    }

    /** Sends an event; if nobody listens yet and [queue] is set, keeps it for drainPending(). */
    fun emit(name: String, body: Map<String, Any?>, queue: Boolean = true) {
        val m = module
        if (m != null && observing) {
            m.emit(name, body)
        } else if (queue) {
            synchronized(pending) { pending.add(body + ("event" to name)) }
        }
    }

    fun drain(): List<Map<String, Any?>> = synchronized(pending) {
        val out = pending.toList()
        pending.clear()
        out
    }

    /** If the app isn't running, open it so JavaScript can pick up the queued event. */
    fun ensureAppRunning(ctx: Context) {
        if (jsReady) return
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        ctx.startActivity(launch)
    }
}
