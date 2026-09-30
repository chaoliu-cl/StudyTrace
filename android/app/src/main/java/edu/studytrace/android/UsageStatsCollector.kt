package edu.studytrace.android

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.provider.Settings
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Thin UsageStatsManager wrapper. Aggregation lives in [UsageAggregator] and
 * [ScreenEvents]; this reads events and queues rows for:
 * - `android_app_usage`: per-app foreground time per completed local day,
 *   uploaded once per day (never the partial current day).
 * - `android_screen_events`: screen on/off and lock/unlock transitions, from
 *   which the server derives pickups and session lengths.
 */
object UsageStatsCollector {
    const val APP_USAGE_SENSOR = "android_app_usage"
    const val SCREEN_EVENTS_SENSOR = "android_screen_events"

    /** Events this far before the first day are read so sessions spanning midnight are paired. */
    private const val SESSION_LOOKBACK_MILLIS = 12L * 60L * 60L * 1000L
    private const val DAY_MILLIS = 24L * 60L * 60L * 1000L

    private val lock = Any()

    fun hasUsageAccess(context: Context): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun usageAccessIntent(): Intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)

    /**
     * Queues app usage for completed days not yet uploaded (at most
     * [UsageAggregator.MAX_BACKFILL_DAYS] back, not before the join day) and
     * screen events since the last run. Returns false without usage access.
     */
    fun collectPending(context: Context, nowMillis: Long = System.currentTimeMillis()): Boolean {
        if (!hasUsageAccess(context)) return false
        synchronized(lock) {
            val prefs = StudyPrefs(context)
            val zone = ZoneId.systemDefault()
            val today = Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalDate()
            val joinedDay = prefs.joinedAtMillis.takeIf { it > 0 }
                ?.let { Instant.ofEpochMilli(it).atZone(zone).toLocalDate() }
            val lastUploaded = runCatching { LocalDate.parse(prefs.usageLastUploadedDate) }.getOrNull()
            val days = UsageAggregator.completedDaysToUpload(lastUploaded, today, joinedDay)

            val screenSupported = Build.VERSION.SDK_INT >= 28
            val screenFloor = maxOf(nowMillis - UsageAggregator.MAX_BACKFILL_DAYS * DAY_MILLIS, prefs.joinedAtMillis)
            val screenAfter = maxOf(prefs.screenLastEventMillis, screenFloor)

            val usageStart = days.firstOrNull()
                ?.let { UsageAggregator.dayWindow(it, zone).first - SESSION_LOOKBACK_MILLIS }
            val queryStart = listOfNotNull(usageStart, if (screenSupported) screenAfter else null).minOrNull()
                ?: return true
            // Null when the query fails (access revoked, user still locked):
            // keep the cursors so the same window is retried next run.
            val events = readEvents(context, queryStart, nowMillis) ?: return false

            if (days.isNotEmpty()) {
                val usage = UsageAggregator.dailyUsage(events, days, zone, nowMillis)
                val labels = mutableMapOf<String, String>()
                val rows = usage.map { day ->
                    val label = labels.getOrPut(day.packageName) { appLabel(context.packageManager, day.packageName) }
                    usageRow(day, label, zone)
                }
                UploadQueue.enqueue(context, APP_USAGE_SENSOR, rows)
                prefs.usageLastUploadedDate = days.last().toString()
            }

            if (screenSupported) {
                val screenEvents = ScreenEvents.fromUsageEvents(events, screenAfter)
                UploadQueue.enqueue(context, SCREEN_EVENTS_SENSOR, screenEvents.map(::screenRow))
                prefs.screenLastEventMillis = screenEvents.lastOrNull()?.timestamp ?: screenAfter
            }
        }
        return true
    }

    private fun readEvents(context: Context, startMillis: Long, endMillis: Long): List<UsageEventRecord>? {
        val usage = context.getSystemService(UsageStatsManager::class.java) ?: return null
        val events = runCatching { usage.queryEvents(startMillis, endMillis) }.getOrNull() ?: return null
        val result = mutableListOf<UsageEventRecord>()
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            if (!events.getNextEvent(event)) break
            if (event.eventType !in RELEVANT_TYPES) continue
            result += UsageEventRecord(
                timestamp = event.timeStamp,
                type = event.eventType,
                packageName = event.packageName.orEmpty(),
                className = event.className,
            )
        }
        return result
    }

    private fun usageRow(day: AppDayUsage, label: String, zone: ZoneId): JSONObject {
        val dedupeKey = "android_usage:${day.date}:${day.packageName}"
        return Telemetry.zoneFields(JSONObject(), day.windowStartMillis)
            .put("timestamp", day.windowStartMillis)
            .put("timezone", zone.id)
            .put("date", day.date.toString())
            .put("package_name", day.packageName)
            .put("app_label", label)
            .put("foreground_seconds", day.foregroundMillis / 1000)
            .put("foreground_ms", day.foregroundMillis)
            .put("launch_count", day.launchCount)
            .put("window_start", day.windowStartMillis)
            .put("window_end", day.windowEndMillis)
            .put("construct", "foreground_time")
            .put("source", "usage_events")
            .put("dedupe_key", dedupeKey)
            .put("event_id", Telemetry.stableEventId(dedupeKey))
    }

    private fun screenRow(event: ScreenEvent): JSONObject =
        Telemetry.zoneFields(JSONObject(), event.timestamp)
            .put("timestamp", event.timestamp)
            .put("event", event.event)
            .put("dedupe_key", event.dedupeKey)
            .put("event_id", Telemetry.stableEventId(event.dedupeKey))

    private fun appLabel(pm: PackageManager, packageName: String): String =
        try {
            val info = pm.getApplicationInfo(packageName, 0)
            pm.getApplicationLabel(info).toString()
        } catch (_: Exception) {
            packageName
        }

    private val RELEVANT_TYPES = setOf(
        UsageAggregator.ACTIVITY_RESUMED,
        UsageAggregator.ACTIVITY_PAUSED,
        UsageAggregator.ACTIVITY_STOPPED,
        UsageAggregator.SCREEN_INTERACTIVE,
        UsageAggregator.SCREEN_NON_INTERACTIVE,
        UsageAggregator.KEYGUARD_SHOWN,
        UsageAggregator.KEYGUARD_HIDDEN,
        UsageAggregator.DEVICE_SHUTDOWN,
        UsageAggregator.DEVICE_STARTUP,
    )
}
