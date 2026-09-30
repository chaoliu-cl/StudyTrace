package edu.studytrace.android

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.util.UUID

class StudyPrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("studytrace", Context.MODE_PRIVATE)

    var studyUrl: String
        get() = prefs.getString(KEY_STUDY_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_STUDY_URL, value).apply()

    var consentGranted: Boolean
        get() = prefs.getBoolean(KEY_CONSENT, false)
        set(value) = prefs.edit().putBoolean(KEY_CONSENT, value).apply()

    var locationTrackingEnabled: Boolean
        get() = prefs.getBoolean(KEY_LOCATION_TRACKING, false)
        set(value) = prefs.edit().putBoolean(KEY_LOCATION_TRACKING, value).apply()

    var lastSyncMillis: Long
        get() = prefs.getLong(KEY_LAST_SYNC, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_SYNC, value).apply()

    /** When this device joined the current study; bounds usage backfill and survey catch-up. */
    var joinedAtMillis: Long
        get() = prefs.getLong(KEY_JOINED_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_JOINED_AT, value).apply()

    var lastHeartbeatMillis: Long
        get() = prefs.getLong(KEY_LAST_HEARTBEAT, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_HEARTBEAT, value).apply()

    var lastEventMillis: Long
        get() = prefs.getLong(KEY_LAST_EVENT, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_EVENT, value).apply()

    /** Last completed local day (yyyy-MM-dd) whose app usage was queued. */
    var usageLastUploadedDate: String
        get() = prefs.getString(KEY_USAGE_LAST_DATE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_USAGE_LAST_DATE, value).apply()

    /** Timestamp of the newest screen/keyguard event already queued. */
    var screenLastEventMillis: Long
        get() = prefs.getLong(KEY_SCREEN_LAST_EVENT, 0L)
        set(value) = prefs.edit().putLong(KEY_SCREEN_LAST_EVENT, value).apply()

    /** JSON object of the permission states in the last device_state row. */
    var permissionSnapshot: String
        get() = prefs.getString(KEY_PERMISSION_SNAPSHOT, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PERMISSION_SNAPSHOT, value).apply()

    /** Rows discarded after a non-retryable server response (reported in heartbeats). */
    var droppedUploadRows: Long
        get() = prefs.getLong(KEY_DROPPED_ROWS, 0L)
        set(value) = prefs.edit().putLong(KEY_DROPPED_ROWS, value).apply()

    /**
     * A withdrawal request not yet accepted by the server (JSON). Survives
     * [clearStudy] on purpose: the study settings are gone by the time it is
     * retried.
     */
    var pendingWithdrawal: String
        get() = prefs.getString(KEY_PENDING_WITHDRAWAL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_PENDING_WITHDRAWAL, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "")?.ifBlank {
            "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        } ?: "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

    val deviceId: String
        get() {
            val existing = prefs.getString(KEY_DEVICE_ID, null)
            if (!existing.isNullOrBlank()) return existing
            val generated = "android-${UUID.randomUUID()}"
            prefs.edit().putString(KEY_DEVICE_ID, generated).apply()
            return generated
        }

    /** Next per-device telemetry sequence number (never reset, so gaps mean lost rows). */
    fun nextSeq(): Long =
        synchronized(seqLock) {
            val next = prefs.getLong(KEY_SEQ, 0L) + 1
            prefs.edit().putLong(KEY_SEQ, next).apply()
            next
        }

    fun addDroppedUploadRows(count: Int) {
        synchronized(seqLock) { droppedUploadRows += count }
    }

    fun clearStudy() {
        prefs.edit()
            .remove(KEY_STUDY_URL)
            .remove(KEY_CONSENT)
            .remove(KEY_LOCATION_TRACKING)
            .remove(KEY_LAST_SYNC)
            .remove(KEY_JOINED_AT)
            .remove(KEY_LAST_HEARTBEAT)
            .remove(KEY_LAST_EVENT)
            .remove(KEY_USAGE_LAST_DATE)
            .remove(KEY_SCREEN_LAST_EVENT)
            .remove(KEY_PERMISSION_SNAPSHOT)
            .remove(KEY_DROPPED_ROWS)
            .apply()
    }

    companion object {
        private val seqLock = Any()

        private const val KEY_STUDY_URL = "study_url"
        private const val KEY_CONSENT = "consent"
        private const val KEY_LOCATION_TRACKING = "location_tracking"
        private const val KEY_LAST_SYNC = "last_sync"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_JOINED_AT = "joined_at"
        private const val KEY_LAST_HEARTBEAT = "last_heartbeat"
        private const val KEY_LAST_EVENT = "last_event"
        private const val KEY_USAGE_LAST_DATE = "usage_last_uploaded_date"
        private const val KEY_SCREEN_LAST_EVENT = "screen_last_event"
        private const val KEY_PERMISSION_SNAPSHOT = "permission_snapshot"
        private const val KEY_DROPPED_ROWS = "dropped_upload_rows"
        private const val KEY_PENDING_WITHDRAWAL = "pending_withdrawal"
        private const val KEY_SEQ = "telemetry_seq"
    }
}
