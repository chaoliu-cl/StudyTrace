package edu.studytrace.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class PromptPlannerTest {
    private val zone = ZoneId.of("America/Chicago")
    private val day = LocalDate.of(2026, 9, 30)

    private fun at(date: LocalDate, hour: Int, minute: Int = 0): Long =
        date.atTime(hour, minute).atZone(zone).toInstant().toEpochMilli()

    private fun schedule(
        slots: List<String> = listOf("09:00", "13:30"),
        randomize: Int = 0,
        expiration: Int = 60,
        start: LocalDate? = null,
        end: LocalDate? = null,
    ) = PromptSchedule("daily", slots, randomize, expiration, start, end)

    @Test
    fun timesWinOverHoursAndAreNormalized() {
        assertEquals(listOf("08:05", "17:00"), PromptPlanner.normalizeSlots(listOf("17:00", "8:05", "bad", "8:05"), listOf(10)))
        assertEquals(listOf("09:00", "15:00"), PromptPlanner.normalizeSlots(emptyList(), listOf(15, 9, 24)))
        assertTrue(PromptPlanner.normalizeSlots(emptyList(), emptyList()).isEmpty())
    }

    @Test
    fun occurrencesUseStableIds() {
        val occurrences = PromptPlanner.occurrencesOn(schedule(), day, zone)
        assertEquals(listOf("daily|2026-09-30|09:00", "daily|2026-09-30|13:30"), occurrences.map { it.id })
        assertEquals(at(day, 9), occurrences[0].promptAtMillis)
        assertEquals(at(day, 10), occurrences[0].expiresAtMillis)
    }

    @Test
    fun scheduleWithoutTimesNeverPrompts() {
        val none = schedule(slots = emptyList())
        assertTrue(PromptPlanner.occurrencesBetween(none, at(day, 0), at(day, 23), zone).isEmpty())
        val plan = PromptPlanner.plan(listOf(none), emptyMap(), at(day, 12), 0L, zone)
        assertTrue(plan.deliver.isEmpty())
        assertTrue(plan.missed.isEmpty())
    }

    @Test
    fun randomizeIsDeterministicAndBounded() {
        val first = PromptPlanner.randomOffsetMinutes("daily", day, "09:00", 30)
        repeat(5) { assertEquals(first, PromptPlanner.randomOffsetMinutes("daily", day, "09:00", 30)) }
        val offsets = (0 until 60).map { PromptPlanner.randomOffsetMinutes("daily", day.plusDays(it.toLong()), "09:00", 30) }
        assertTrue(offsets.all { it in -30..30 })
        // Different occurrences get different offsets (not one fixed shift).
        assertTrue(offsets.toSet().size > 1)
        assertEquals(0, PromptPlanner.randomOffsetMinutes("daily", day, "09:00", 0))

        val occurrence = PromptPlanner.occurrencesOn(schedule(randomize = 30), day, zone).first()
        assertEquals(at(day, 9) + first * 60_000L, occurrence.promptAtMillis)
        assertEquals(occurrence, PromptPlanner.occurrencesOn(schedule(randomize = 30), day, zone).first())
    }

    @Test
    fun expirationCountsFromOriginalSlotLikeAware() {
        val occurrence = PromptPlanner.occurrencesOn(schedule(randomize = 30, expiration = 60), day, zone).first()
        val offset = PromptPlanner.randomOffsetMinutes("daily", day, "09:00", 30)
        val expected = if (offset < 60) at(day, 10) else occurrence.promptAtMillis + 60 * 60_000L
        assertEquals(expected, occurrence.expiresAtMillis)
        assertTrue(occurrence.expiresAtMillis > occurrence.promptAtMillis)
    }

    @Test
    fun zeroExpirationLastsUntilEndOfDay() {
        val occurrence = PromptPlanner.occurrencesOn(schedule(expiration = 0), day, zone).first()
        assertEquals(day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli(), occurrence.expiresAtMillis)
    }

    @Test
    fun dateRangeIsRespected() {
        val ranged = schedule(start = day, end = day.plusDays(1))
        assertTrue(PromptPlanner.occurrencesOn(ranged, day.minusDays(1), zone).isEmpty())
        assertEquals(2, PromptPlanner.occurrencesOn(ranged, day, zone).size)
        assertEquals(2, PromptPlanner.occurrencesOn(ranged, day.plusDays(1), zone).size)
        assertTrue(PromptPlanner.occurrencesOn(ranged, day.plusDays(2), zone).isEmpty())
    }

    @Test
    fun parsesServerAndIsoDates() {
        assertEquals(day, PromptPlanner.parseScheduleDate("09-30-2026"))
        assertEquals(day, PromptPlanner.parseScheduleDate("2026-09-30"))
        assertNull(PromptPlanner.parseScheduleDate(""))
        assertNull(PromptPlanner.parseScheduleDate("30/09/2026"))
    }

    @Test
    fun deliversOnceInsideWindow() {
        val plan = PromptPlanner.plan(listOf(schedule()), emptyMap(), at(day, 9, 10), 0L, zone)
        assertEquals(listOf("daily|2026-09-30|09:00"), plan.deliver.map { it.id })

        val delivered = plan.deliver.first()
        val records = mapOf(
            delivered.id to OccurrenceRecord(
                delivered.id, "daily", OccurrenceStatus.DELIVERED,
                delivered.promptAtMillis, at(day, 9, 10), delivered.expiresAtMillis,
            ),
        )
        val next = PromptPlanner.plan(listOf(schedule()), records, at(day, 9, 25), 0L, zone)
        assertTrue(next.deliver.isEmpty())
        assertTrue(next.expire.isEmpty())
    }

    @Test
    fun deliveredPromptExpiresAfterWindow() {
        val occurrence = PromptPlanner.occurrencesOn(schedule(), day, zone).first()
        val record = OccurrenceRecord(
            occurrence.id, "daily", OccurrenceStatus.DELIVERED,
            occurrence.promptAtMillis, occurrence.promptAtMillis, occurrence.expiresAtMillis,
        )
        val plan = PromptPlanner.plan(listOf(schedule()), mapOf(record.id to record), at(day, 10, 5), 0L, zone)
        assertEquals(listOf(record), plan.expire)

        val answered = record.copy(status = OccurrenceStatus.ANSWERED)
        val later = PromptPlanner.plan(listOf(schedule()), mapOf(answered.id to answered), at(day, 10, 5), 0L, zone)
        assertTrue(later.expire.isEmpty())
    }

    @Test
    fun windowPassedWhileAsleepIsMissedNotDelivered() {
        val plan = PromptPlanner.plan(listOf(schedule()), emptyMap(), at(day, 10, 30), at(day, 0), zone)
        assertTrue(plan.deliver.isEmpty())
        assertEquals(listOf("daily|2026-09-30|09:00"), plan.missed.map { it.id })
    }

    @Test
    fun onlyNewestOpenOccurrencePerScheduleIsDelivered() {
        val hourly = schedule(slots = listOf("09:00", "10:00"), expiration = 120)
        val plan = PromptPlanner.plan(listOf(hourly), emptyMap(), at(day, 10, 15), at(day, 0), zone)
        assertEquals(listOf("daily|2026-09-30|10:00"), plan.deliver.map { it.id })
        assertEquals(listOf("daily|2026-09-30|09:00"), plan.missed.map { it.id })
    }

    @Test
    fun lookbackIsLimitedToFortyEightHours() {
        val plan = PromptPlanner.plan(listOf(schedule()), emptyMap(), at(day, 8), 0L, zone)
        // Window is (day-2 08:00, day 08:00]: day-2 09:00/13:30 and day-1 09:00/13:30.
        assertEquals(4, plan.missed.size)
        assertEquals("daily|2026-09-28|09:00", plan.missed.first().id)
        assertTrue(plan.deliver.isEmpty())
    }

    @Test
    fun occurrencesBeforeFloorAreIgnored() {
        // Joined at 09:30: the 09:00 prompt predates participation.
        val plan = PromptPlanner.plan(listOf(schedule()), emptyMap(), at(day, 9, 45), at(day, 9, 30), zone)
        assertTrue(plan.deliver.isEmpty())
        assertTrue(plan.missed.isEmpty())
    }

    @Test
    fun screenshotPromptTypesAreIosOnly() {
        assertFalse(PromptPlanner.isAndroidSurvey("battery_usage_screenshot", "anything"))
        assertFalse(PromptPlanner.isAndroidSurvey("screen_time_activity_screenshot", "anything"))
        assertTrue(PromptPlanner.isAndroidSurvey("esm_survey", "studytrace_fixed_battery_screenshot"))
        assertFalse(PromptPlanner.isAndroidSurvey("", "studytrace_fixed_battery_screenshot"))
        assertFalse(PromptPlanner.isAndroidSurvey(null, "studytrace_random_screen_time_activity"))
        assertTrue(PromptPlanner.isAndroidSurvey(null, "morning_mood"))
        assertTrue(PromptPlanner.isAndroidSurvey("ESM", "anything"))
        // The server treats unknown types as screenshot prompts, so Android does too.
        assertFalse(PromptPlanner.isAndroidSurvey("photo_diary", "anything"))
    }
}
