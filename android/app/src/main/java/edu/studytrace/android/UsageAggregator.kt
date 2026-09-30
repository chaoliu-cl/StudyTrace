package edu.studytrace.android

import java.time.LocalDate
import java.time.ZoneId

// Pure app-usage aggregation (no Android framework calls) so it can be unit
// tested on the JVM. UsageStatsCollector reads UsageStatsManager.queryEvents
// into UsageEventRecord values and hands them to these functions.

/** One UsageEvents.Event, copied out of the framework object. */
data class UsageEventRecord(
    val timestamp: Long,
    val type: Int,
    val packageName: String,
    val className: String? = null,
)

/** A continuous stretch in which at least one activity of a package was resumed. */
data class ForegroundSession(
    val packageName: String,
    val startMillis: Long,
    val endMillis: Long,
)

/** Foreground time of one package within one local calendar day. */
data class AppDayUsage(
    val date: LocalDate,
    val packageName: String,
    val foregroundMillis: Long,
    val launchCount: Int,
    val windowStartMillis: Long,
    val windowEndMillis: Long,
)

object UsageAggregator {
    // UsageEvents.Event constants. ACTIVITY_RESUMED/PAUSED (API 29) share
    // their values with the older MOVE_TO_FOREGROUND/MOVE_TO_BACKGROUND.
    const val ACTIVITY_RESUMED = 1
    const val ACTIVITY_PAUSED = 2
    const val SCREEN_INTERACTIVE = 15
    const val SCREEN_NON_INTERACTIVE = 16
    const val KEYGUARD_SHOWN = 17
    const val KEYGUARD_HIDDEN = 18
    const val ACTIVITY_STOPPED = 23
    const val DEVICE_SHUTDOWN = 26
    const val DEVICE_STARTUP = 27

    const val MAX_BACKFILL_DAYS = 7L

    /**
     * Pairs resume/pause events into per-package foreground sessions. A
     * package stays in the foreground while any of its activities is resumed
     * (activity-to-activity transitions inside one app are one session).
     * Screen-off and shutdown/startup close every open session, which also
     * bounds sessions whose pause event was never logged. Sessions still open
     * at [endMillis] are closed there.
     */
    fun sessions(events: List<UsageEventRecord>, endMillis: Long): List<ForegroundSession> {
        val resumed = mutableMapOf<String, MutableSet<String>>()
        val starts = mutableMapOf<String, Long>()
        val result = mutableListOf<ForegroundSession>()

        fun close(packageName: String, at: Long) {
            val start = starts.remove(packageName) ?: return
            resumed.remove(packageName)
            if (at > start) result += ForegroundSession(packageName, start, at)
        }

        fun closeAll(at: Long) {
            starts.keys.toList().forEach { close(it, at) }
        }

        for (event in events.sortedBy { it.timestamp }) {
            if (event.timestamp > endMillis) break
            val activity = event.className.orEmpty()
            when (event.type) {
                ACTIVITY_RESUMED -> {
                    if (event.packageName.isEmpty()) continue
                    val set = resumed.getOrPut(event.packageName) { mutableSetOf() }
                    if (set.isEmpty()) starts[event.packageName] = event.timestamp
                    set += activity
                }
                ACTIVITY_PAUSED, ACTIVITY_STOPPED -> {
                    val set = resumed[event.packageName] ?: continue
                    set -= activity
                    if (set.isEmpty()) close(event.packageName, event.timestamp)
                }
                SCREEN_NON_INTERACTIVE, DEVICE_SHUTDOWN, DEVICE_STARTUP -> closeAll(event.timestamp)
            }
        }
        closeAll(endMillis)
        return result.sortedWith(compareBy({ it.startMillis }, { it.packageName }))
    }

    /** Local-midnight bounds [start, end) of [date] in [zone] (DST aware). */
    fun dayWindow(date: LocalDate, zone: ZoneId): Pair<Long, Long> =
        date.atStartOfDay(zone).toInstant().toEpochMilli() to
            date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()

    /**
     * Clips [sessions] to each day's local-midnight window. A launch is
     * counted on the day its session started. Packages with neither time nor
     * launches on a day are omitted.
     */
    fun dailyUsage(sessions: List<ForegroundSession>, days: List<LocalDate>, zone: ZoneId): List<AppDayUsage> {
        val rows = mutableListOf<AppDayUsage>()
        for (date in days.sorted()) {
            val (dayStart, dayEnd) = dayWindow(date, zone)
            val foreground = mutableMapOf<String, Long>()
            val launches = mutableMapOf<String, Int>()
            for (session in sessions) {
                val overlap = minOf(session.endMillis, dayEnd) - maxOf(session.startMillis, dayStart)
                if (overlap > 0) foreground[session.packageName] = (foreground[session.packageName] ?: 0L) + overlap
                if (session.startMillis in dayStart until dayEnd) launches[session.packageName] = (launches[session.packageName] ?: 0) + 1
            }
            (foreground.keys + launches.keys).sorted().forEach { packageName ->
                rows += AppDayUsage(
                    date = date,
                    packageName = packageName,
                    foregroundMillis = foreground[packageName] ?: 0L,
                    launchCount = launches[packageName] ?: 0,
                    windowStartMillis = dayStart,
                    windowEndMillis = dayEnd,
                )
            }
        }
        return rows
    }

    /** Convenience: [sessions] then [dailyUsage]. */
    fun dailyUsage(events: List<UsageEventRecord>, days: List<LocalDate>, zone: ZoneId, endMillis: Long): List<AppDayUsage> =
        dailyUsage(sessions(events, endMillis), days, zone)

    /**
     * Completed local days still to upload: after [lastUploaded], not before
     * [earliest] (the join day), at most [maxBackfill] days back, and never
     * [today] itself (it is still partial).
     */
    fun completedDaysToUpload(
        lastUploaded: LocalDate?,
        today: LocalDate,
        earliest: LocalDate?,
        maxBackfill: Long = MAX_BACKFILL_DAYS,
    ): List<LocalDate> {
        var first = today.minusDays(maxBackfill)
        if (lastUploaded != null && !lastUploaded.plusDays(1).isBefore(first)) first = lastUploaded.plusDays(1)
        if (earliest != null && earliest.isAfter(first)) first = earliest
        val days = mutableListOf<LocalDate>()
        var date = first
        while (date.isBefore(today)) {
            days += date
            date = date.plusDays(1)
        }
        return days
    }
}

/** A screen or keyguard transition, as uploaded to `android_screen_events`. */
data class ScreenEvent(val timestamp: Long, val event: String) {
    val dedupeKey: String get() = "screen:$timestamp:$event"
}

object ScreenEvents {
    const val SCREEN_ON = "screen_on"
    const val SCREEN_OFF = "screen_off"
    const val LOCK = "lock"
    const val UNLOCK = "unlock"

    /** Maps a UsageEvents type (API 28+) to the uploaded event name. */
    fun eventName(type: Int): String? =
        when (type) {
            UsageAggregator.SCREEN_INTERACTIVE -> SCREEN_ON
            UsageAggregator.SCREEN_NON_INTERACTIVE -> SCREEN_OFF
            UsageAggregator.KEYGUARD_SHOWN -> LOCK
            UsageAggregator.KEYGUARD_HIDDEN -> UNLOCK
            else -> null
        }

    /** Screen events strictly after [afterMillis], oldest first. */
    fun fromUsageEvents(events: List<UsageEventRecord>, afterMillis: Long): List<ScreenEvent> =
        events.asSequence()
            .filter { it.timestamp > afterMillis }
            .mapNotNull { event -> eventName(event.type)?.let { ScreenEvent(event.timestamp, it) } }
            .distinct()
            .sortedBy { it.timestamp }
            .toList()
}
