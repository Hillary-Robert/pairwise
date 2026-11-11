package app.pairwise.nativebridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app process alive while paired, so the connection survives the app going to the
 * background. React Native pauses JavaScript timers in the background, so this service also
 * sends a "tick" every 15 seconds and a "network" event when connectivity changes; JavaScript
 * uses them to reconnect.
 */
class PairwiseLinkService : Service() {
    companion object {
        private const val CHANNEL = "pairwise_link"
        private const val NOTIFICATION_ID = 4782
        private const val TICK_MS = 15_000L

        fun start(ctx: Context, title: String, text: String) {
            val i = Intent(ctx, PairwiseLinkService::class.java).putExtra("title", title).putExtra("text", text)
            ContextCompat.startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PairwiseLinkService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            PairwiseEvents.emit("onTick", emptyMap(), queue = false)
            handler.postDelayed(this, TICK_MS)
        }
    }
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Connection to your computer", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shows while Pairwise stays connected in the background"
                setShowBadge(false)
            },
        )
        handler.postDelayed(tick, TICK_MS)
        val cm = getSystemService(ConnectivityManager::class.java)
        netCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                PairwiseEvents.emit("onNetwork", mapOf("available" to true), queue = false)
            }
            override fun onLost(network: Network) {
                PairwiseEvents.emit("onNetwork", mapOf("available" to false), queue = false)
            }
        }.also { cm.registerDefaultNetworkCallback(it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra("title") ?: "Pairwise"
        val text = intent?.getStringExtra("text") ?: ""
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(title, text), type)
        // Not sticky: a restarted process wouldn't have JavaScript running to use the connection.
        return START_NOT_STICKY
    }

    private fun notification(title: String, text: String): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val sendClip = PendingIntent.getActivity(
            this, 1,
            Intent(this, ClipSendActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_pairwise)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .addAction(0, "Send clipboard", sendClip)
            .build()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        netCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        super.onDestroy()
    }
}
