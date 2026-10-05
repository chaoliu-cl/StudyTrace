package edu.studytrace.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class UsageAggregatorTest {
    private val zone = ZoneId.of("America/New_York")
    private val day1 = LocalDate.of(2026, 3, 3)
    private val day2 = day1.plusDays(1)

    private fun at(date: LocalDate, hour: Int, minute: Int = 0, second: Int = 0): Long =
        date.atTime(hour, minute, second).atZone(zone).toInstant().toEpochMilli()

    private fun resumed(ts: Long, pkg: String, cls: String = "$pkg.Main") =
        UsageEventRecord(ts, UsageAggregator.ACTIVITY_RESUMED, pkg, cls)

    private fun paused(ts: Long, pkg: String, cls: String = "$pkg.Main") =
        UsageEventRecord(ts, UsageAggregator.ACTIVITY_PAUSED, pkg, cls)

    @Test
    fun pairsResumeAndPauseIntoSessions() {
        val events = listOf(
            resumed(at(day1, 9), "com.a"),
            paused(at(day1, 9, 10), "com.a"),
            resumed(at(day1, 9, 10), "com.b"),
            paused(at(day1, 9, 15), "com.b"),
        )
        val sessions = UsageAggregator.sessions(events, at(day1, 23))
        assertEquals(
            listOf(
                ForegroundSession("com.a", at(day1, 9), at(day1, 9, 10)),
                ForegroundSession("com.b", at(day1, 9, 10), at(day1, 9, 15)),
            ),
            sessions,
        )
    }

    @Test
    fun activityTransitionsInsideOneAppAreOneSession() {
        val events = listOf(
            resumed(at(day1, 10), "com.a", "com.a.List"),
            // Newer Android versions may log B resumed before A paused.
            resumed(at(day1, 10, 5), "com.a", "com.a.Detail"),
            paused(at(day1, 10, 5), "com.a", "com.a.List"),
            paused(at(day1, 10, 20), "com.a", "com.a.Detail"),
        )
        val usage = UsageAggregator.dailyUsage(events, listOf(day1), zone, at(day1, 23))
        assertEquals(1, usage.size)
        assertEquals(20 * 60_000L, usage[0].foregroundMillis)
        assertEquals(1, usage[0].launchCount)
    }

    @Test
    fun clipsSessionsAtLocalMidnight() {
        val events = listOf(
            resumed(at(day1, 23, 50), "com.video"),
            paused(at(day2, 0, 20), "com.video"),
        )
        val usage = UsageAggregator.dailyUsage(events, listOf(day1, day2), zone, at(day2, 12))
        assertEquals(2, usage.size)
        val first = usage.first { it.date == day1 }
        val second = usage.first { it.date == day2 }
        assertEquals(10 * 60_000L, first.foregroundMillis)
        assertEquals(1, first.launchCount)
        assertEquals(20 * 60_000L, second.foregroundMillis)
        // The launch belongs to the day the session started.
        assertEquals(0, second.launchCount)
        assertEquals(at(day2, 0), second.windowStartMillis)
        assertEquals(day2.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli(), second.windowEndMillis)
    }

    @Test
    fun screenOffClosesSessionsWithMissingPause() {
        val events = listOf(
            resumed(at(day1, 8), "com.a"),
            UsageEventRecord(at(day1, 8, 30), UsageAggregator.SCREEN_NON_INTERACTIVE, "android"),
            // Pause logged after screen-off must not extend or duplicate the session.
            paused(at(day1, 8, 31), "com.a"),
        )
        val sessions = UsageAggregator.sessions(events, at(day1, 23))
        assertEquals(listOf(ForegroundSession("com.a", at(day1, 8), at(day1, 8, 30))), sessions)
    }

    @Test
    fun openSessionIsClosedAtEnd() {
        val end = at(day1, 12)
        val sessions = UsageAggregator.sessions(listOf(resumed(at(day1, 11, 45), "com.a")), end)
        assertEquals(listOf(ForegroundSession("com.a", at(day1, 11, 45), end)), sessions)
    }

    @Test
    fun unmatchedPauseIsIgnored() {
        val sessions = UsageAggregator.sessions(listOf(paused(at(day1, 7), "com.a")), at(day1, 23))
        assertTrue(sessions.isEmpty())
    }

    @Test
    fun dstDayWindowIsTwentyThreeHours() {
        // 2026-03-08 is the spring-forward day in America/New_York.
        val (start, end) = UsageAggregator.dayWindow(LocalDate.of(2026, 3, 8), zone)
        assertEquals(23L * 60 * 60 * 1000, end - start)
    }

    @Test
    fun completedDaysNeverIncludeToday() {
        val today = LocalDate.of(2026, 9, 30)
        val days = UsageAggregator.completedDaysToUpload(today.minusDays(1), today, null)
        assertTrue(days.isEmpty())
    }

    @Test
    fun completedDaysResumeAfterLastUploaded() {
        val today = LocalDate.of(2026, 9, 30)
        val days = UsageAggregator.completedDaysToUpload(today.minusDays(3), today, null)
        assertEquals(listOf(today.minusDays(2), today.minusDays(1)), days)
    }

    @Test
    fun backfillIsCappedAtSevenDays() {
        val today = LocalDate.of(2026, 9, 30)
        val days = UsageAggregator.completedDaysToUpload(null, today, null)
        assertEquals(7, days.size)
        assertEquals(today.minusDays(7), days.first())
        assertEquals(today.minusDays(1), days.last())
        val stale = UsageAggregator.completedDaysToUpload(today.minusDays(30), today, null)
        assertEquals(days, stale)
    }

    @Test
    fun backfillStartsNoEarlierThanJoinDay() {
        val today = LocalDate.of(2026, 9, 30)
        val days = UsageAggregator.completedDaysToUpload(null, today, today.minusDays(2))
        assertEquals(listOf(today.minusDays(2), today.minusDays(1)), days)
    }
}
