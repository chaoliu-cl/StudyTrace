package edu.studytrace.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

object NotificationHelper {
    const val LOCATION_CHANNEL_ID = "studytrace_location"
    const val SYNC_CHANNEL_ID = "studytrace_sync"
    const val LOCATION_NOTIFICATION_ID = 2001
    const val SURVEY_NOTIFICATION_ID = 2002

    /** Intent extra carrying the prompt occurrence id ("<schedule_id>|<date>|<HH:MM>"). */
    const val EXTRA_OCCURRENCE_ID = "edu.studytrace.android.extra.OCCURRENCE_ID"

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                LOCATION_CHANNEL_ID,
                context.getString(R.string.location_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            )
        )
        manager.createNotificationChannel(
            NotificationChannel(
                SYNC_CHANNEL_ID,
                context.getString(R.string.sync_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            )
        )
    }

    fun locationNotification(context: Context): Notification =
        NotificationCompat.Builder(context, LOCATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_studytrace)
            .setContentTitle(context.getString(R.string.location_notification_title))
            .setContentText(context.getString(R.string.location_notification_body))
            .setOngoing(true)
            .setContentIntent(openAppIntent(context, null))
            .build()

    /** Posts one notification per prompt occurrence, tagged with its id so it can be cancelled on expiry. */
    fun showSurveyNotification(context: Context, occurrenceId: String, title: String, body: String) {
        ensureChannels(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        val notification = NotificationCompat.Builder(context, SYNC_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_studytrace)
            .setContentTitle(title.ifBlank { context.getString(R.string.survey_notification_default_title) })
            .setContentText(body.ifBlank { context.getString(R.string.survey_notification_default_body) })
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(context, occurrenceId))
            .build()
        manager.notify(occurrenceId, SURVEY_NOTIFICATION_ID, notification)
    }

    fun cancelSurveyNotification(context: Context, occurrenceId: String) {
        context.getSystemService(NotificationManager::class.java).cancel(occurrenceId, SURVEY_NOTIFICATION_ID)
    }

    /** Removes every StudyTrace notification (withdrawal). */
    fun cancelAll(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    private fun openAppIntent(context: Context, occurrenceId: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (occurrenceId != null) intent.putExtra(EXTRA_OCCURRENCE_ID, occurrenceId)
        return PendingIntent.getActivity(
            context,
            // Distinct request codes keep each prompt's extras from overwriting another's.
            occurrenceId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
