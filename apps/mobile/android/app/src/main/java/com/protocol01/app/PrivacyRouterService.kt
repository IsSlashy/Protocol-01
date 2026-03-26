package com.protocol01.app

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Privacy Router Foreground Service
 *
 * Keeps the app alive in the background so privacy route hops can execute
 * on schedule even when the user closes the app.
 *
 * Shows a persistent notification: "Privacy route active — N hops remaining"
 * This is required by Android for foreground services.
 *
 * The actual hop execution happens in JS via expo-task-manager.
 * This service just prevents Android from killing the process.
 */
class PrivacyRouterService : Service() {

    companion object {
        private const val TAG = "PrivacyRouter"
        private const val CHANNEL_ID = "privacy_router_channel"
        private const val NOTIFICATION_ID = 9901
        private const val WAKELOCK_TAG = "P01::PrivacyRouter"

        var isRunning = false
            private set

        fun start(context: Context, hopsRemaining: Int = 0, eta: String = "") {
            val intent = Intent(context, PrivacyRouterService::class.java).apply {
                putExtra("hops_remaining", hopsRemaining)
                putExtra("eta", eta)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, PrivacyRouterService::class.java))
        }

        fun updateNotification(context: Context, hopsRemaining: Int, eta: String) {
            if (!isRunning) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, buildNotification(context, hopsRemaining, eta))
        }

        private fun buildNotification(context: Context, hopsRemaining: Int, eta: String): Notification {
            val contentText = if (hopsRemaining > 0) {
                "Privacy route active — $hopsRemaining hops remaining${if (eta.isNotEmpty()) " • ETA: $eta" else ""}"
            } else {
                "Privacy router running — monitoring routes"
            }

            // Tap notification → open app
            val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pendingIntent = PendingIntent.getActivity(
                context, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setContentTitle("Protocol 01")
                .setContentText(contentText)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(pendingIntent)
                .build()
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        Log.i(TAG, "Service created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val hops = intent?.getIntExtra("hops_remaining", 0) ?: 0
        val eta = intent?.getStringExtra("eta") ?: ""

        startForeground(NOTIFICATION_ID, buildNotification(this, hops, eta))
        isRunning = true

        // Acquire partial wake lock to keep CPU running
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            acquire(24 * 60 * 60 * 1000L) // 24h max (paranoid route duration)
        }

        Log.i(TAG, "Foreground service started — $hops hops remaining")
        return START_STICKY // Restart if killed
    }

    override fun onDestroy() {
        isRunning = false
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
        Log.i(TAG, "Service stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Privacy Router",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps privacy routes executing in background"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET // Don't show content on lock screen
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }
}
