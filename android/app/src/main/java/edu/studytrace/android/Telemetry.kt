package edu.studytrace.android

import android.content.Context
import org.json.JSONObject
import java.util.TimeZone
import java.util.UUID

/**
 * Builds and queues `client_events` and `device_state` rows. Every row gets
 * timestamp (epoch ms), a unique event_id (server dedupe of retries), a
 * per-device seq (so the server can count rows lost in transit), the IANA
 * time zone with its current UTC offset, and platform "android".
 */
object Telemetry {
    const val CLIENT_EVENTS = "client_events"
    const val DEVICE_STATE = "device_state"

    private const val HEARTBEAT_INTERVAL_MILLIS = 55L * 60L * 1000L
    private val permissionLock = Any()

    /** Time-zone and platform fields shared by every uploaded row. */
    fun zoneFields(row: JSONObject, atMillis: Long = System.currentTimeMillis()): JSONObject {
        val zone = TimeZone.getDefault()
        return row
            .put("timezone", zone.id)
            .put("utc_offset_minutes", zone.getOffset(atMillis) / 60_000)
            .put("platform", "android")
    }

    /** Deterministic UUID for rows that may be regenerated (e.g. one per prompt occurrence). */
    fun stableEventId(key: String): String = UUID.nameUUIDFromBytes(key.toByteArray(Charsets.UTF_8)).toString()

    private fun commonFields(context: Context, eventId: String?): JSONObject {
        val now = System.currentTimeMillis()
        return zoneFields(JSONObject(), now)
            .put("timestamp", now)
            .put("event_id", eventId ?: UUID.randomUUID().toString())
            .put("seq", StudyPrefs(context).nextSeq())
            .put("app_version", BuildInfo.versionName(context))
    }

    /** Queues a client_events row. [eventId] makes a re-recorded event dedupe on the server. */
    fun recordEvent(context: Context, name: String, metadata: JSONObject? = null, eventId: String? = null) {
        val prefs = StudyPrefs(context)
        if (!prefs.consentGranted) return
        val row = commonFields(context, eventId).put("event_name", name)
        if (metadata != null && metadata.length() > 0) row.put("metadata", metadata)
        prefs.lastEventMillis = System.currentTimeMillis()
        UploadQueue.enqueue(context, CLIENT_EVENTS, row)
    }

    /**
     * Queues a device_state snapshot and a permission_changed event for each
     * permission that differs from the previous snapshot.
     */
    fun recordDeviceState(context: Context, reason: String) {
        val prefs = StudyPrefs(context)
        if (!prefs.consentGranted) return
        val state = DeviceStateCollector.row(context, reason)
        val row = commonFields(context, null)
        state.keys().forEach { key -> row.put(key, state.get(key)) }
        recordPermissionChanges(context, row)
        UploadQueue.enqueue(context, DEVICE_STATE, row)
    }

    /** Queues a heartbeat when none was sent in roughly the last hour. */
    fun recordHeartbeatIfDue(context: Context, source: String) {
        val prefs = StudyPrefs(context)
        val now = System.currentTimeMillis()
        if (!prefs.consentGranted || now - prefs.lastHeartbeatMillis < HEARTBEAT_INTERVAL_MILLIS) return
        prefs.lastHeartbeatMillis = now
        recordEvent(
            context,
            "heartbeat",
            JSONObject()
                .put("source", source)
                .put("pending_uploads", UploadQueue.pendingCount(context))
                .put("dropped_upload_rows", prefs.droppedUploadRows)
                .put("location_tracking_enabled", prefs.locationTrackingEnabled),
        )
    }

    /** app_launch with why the UI opened and how long telemetry was silent before. */
    fun recordAppLaunch(context: Context, reason: String) {
        val prefs = StudyPrefs(context)
        val metadata = JSONObject().put("launch_reason", reason)
        val previous = prefs.lastEventMillis
        if (previous > 0) {
            metadata.put("previous_last_event_at", previous)
            metadata.put("minutes_since_previous_event", (System.currentTimeMillis() - previous) / 60_000)
        }
        recordEvent(context, "app_launch", metadata)
    }

    private fun recordPermissionChanges(context: Context, row: JSONObject) {
        val prefs = StudyPrefs(context)
        val current = JSONObject()
        DeviceStateCollector.PERMISSION_KEYS.forEach { key ->
            row.optString(key).takeIf { it.isNotEmpty() }?.let { current.put(key, it) }
        }
        val previous = synchronized(permissionLock) {
            val stored = prefs.permissionSnapshot
            prefs.permissionSnapshot = current.toString()
            stored.takeIf { it.isNotBlank() }?.let { runCatching { JSONObject(it) }.getOrNull() }
        } ?: return
        DeviceStateCollector.PERMISSION_KEYS.forEach { key ->
            val old = previous.optString(key)
            val updated = current.optString(key)
            if (old.isNotEmpty() && updated.isNotEmpty() && old != updated) {
                recordEvent(
                    context,
                    "permission_changed",
                    JSONObject().put("permission", key).put("from", old).put("to", updated),
                )
            }
        }
    }
}

private object BuildInfo {
    @Volatile private var cached: String? = null

    fun versionName(context: Context): String =
        cached ?: runCatching {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull().orEmpty().also { cached = it }
}
