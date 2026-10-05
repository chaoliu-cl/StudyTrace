package edu.studytrace.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (StudyWithdrawal.hasPending(context)) WithdrawalWorker.enqueue(context)
        val prefs = StudyPrefs(context)
        if (!prefs.consentGranted || !prefs.enrollmentConfirmed || parseStudyContext(prefs.studyUrl) == null) return
        SyncWorker.schedule(context)
        if (prefs.locationTrackingEnabled) {
            runCatching {
                ContextCompat.startForegroundService(context, Intent(context, LocationTrackingService::class.java))
            }
        }
    }
}
