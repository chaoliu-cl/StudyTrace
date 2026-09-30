package edu.studytrace.android

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.Random

// Pure survey-prompt scheduling logic (no Android framework calls) so it can
// be unit tested on the JVM. SurveyRepository adapts the server JSON to these
// types and applies the resulting plan.

/** One ESM schedule from `.../esm/config`, reduced to what timing needs. */
data class PromptSchedule(
    val scheduleId: String,
    /** Normalized "HH:MM" slots, sorted and unique. Empty means never prompt. */
    val slots: List<String>,
    val randomizeMinutes: Int,
    val expirationMinutes: Int,
    val startDate: LocalDate?,
    val endDate: LocalDate?,
)

/** A concrete prompt: one schedule slot on one local day. */
data class PromptOccurrence(
    /** Stable id "<schedule_id>|<yyyy-MM-dd>|<HH:MM>" (also the notification_id). */
    val id: String,
    val scheduleId: String,
    val date: LocalDate,
    val slot: String,
    /** Slot time before randomization. */
    val originalAtMillis: Long,
    /** Slot time after the deterministic random offset. */
    val promptAtMillis: Long,
    val expiresAtMillis: Long,
)

enum class OccurrenceStatus { DELIVERED, ANSWERED, DISMISSED, EXPIRED, MISSED }

/** Persisted state of an occurrence this device has already handled. */
data class OccurrenceRecord(
    val id: String,
    val scheduleId: String,
    val status: OccurrenceStatus,
    val promptAtMillis: Long,
    val deliveredAtMillis: Long,
    val expiresAtMillis: Long,
)

data class PromptPlan(
    /** Occurrences to notify now (at most one per schedule). */
    val deliver: List<PromptOccurrence>,
    /** Delivered, unanswered occurrences whose window has closed. */
    val expire: List<OccurrenceRecord>,
    /** Occurrences whose window passed before this device could notify. */
    val missed: List<PromptOccurrence>,
)

object PromptPlanner {
    /** Prompt types that only make sense on iOS (Battery / Screen Time screenshots). */
    val IOS_ONLY_PROMPT_TYPES = setOf("battery_usage_screenshot", "screen_time_activity_screenshot")

    /** How far back a run looks for occurrences it has not handled yet. */
    const val LOOKBACK_MILLIS = 48L * 60L * 60L * 1000L

    private val usDate = DateTimeFormatter.ofPattern("MM-dd-yyyy", Locale.US)

    /** studytrace_prompt_type values the server normalizes to an ESM survey. */
    private val SURVEY_PROMPT_TYPES = setOf("esm", "esm_survey", "survey")

    /**
     * Mirrors the server's schedulePromptType(): an explicit
     * studytrace_prompt_type is a survey only if it is an ESM type (the server
     * maps every other value, including [IOS_ONLY_PROMPT_TYPES], to a
     * screenshot prompt); without one, the schedule id decides.
     */
    fun isAndroidSurvey(promptType: String?, scheduleId: String): Boolean {
        val type = promptType?.trim()?.lowercase().orEmpty()
        if (type.isNotEmpty()) return type in SURVEY_PROMPT_TYPES
        val id = scheduleId.lowercase()
        return !(id.contains("screen_time_activity") || id.contains("battery_screenshot") || id.contains("battery_usage"))
    }

    /** Uses `times` ("HH:MM") when present, otherwise whole `hours`. */
    fun normalizeSlots(times: List<String>, hours: List<Int>): List<String> {
        val fromTimes = times.mapNotNull(::parseSlot)
        val minutes = if (fromTimes.isNotEmpty()) {
            fromTimes
        } else {
            hours.filter { it in 0..23 }.map { it * 60 }
        }
        return minutes.distinct().sorted().map { "%02d:%02d".format(Locale.US, it / 60, it % 60) }
    }

    /** Server dates are "MM-dd-yyyy"; ISO "yyyy-MM-dd" is accepted too. */
    fun parseScheduleDate(value: String?): LocalDate? {
        val text = value?.trim().orEmpty()
        if (text.isEmpty()) return null
        return runCatching { LocalDate.parse(text, usDate) }.getOrNull()
            ?: runCatching { LocalDate.parse(text) }.getOrNull()
    }

    fun occurrenceId(scheduleId: String, date: LocalDate, slot: String): String = "$scheduleId|$date|$slot"

    /**
     * Offset in [-randomize, +randomize] minutes (AWARE semantics), seeded by
     * the occurrence so every worker run computes the same prompt time.
     */
    fun randomOffsetMinutes(scheduleId: String, date: LocalDate, slot: String, randomizeMinutes: Int): Int {
        if (randomizeMinutes <= 0) return 0
        val random = Random(stableHash(occurrenceId(scheduleId, date, slot)))
        return random.nextInt(randomizeMinutes * 2 + 1) - randomizeMinutes
    }

    fun isActiveOn(schedule: PromptSchedule, date: LocalDate): Boolean {
        if (schedule.startDate != null && date.isBefore(schedule.startDate)) return false
        if (schedule.endDate != null && date.isAfter(schedule.endDate)) return false
        return true
    }

    fun occurrencesOn(schedule: PromptSchedule, date: LocalDate, zone: ZoneId): List<PromptOccurrence> {
        if (!isActiveOn(schedule, date)) return emptyList()
        return schedule.slots.mapNotNull { slot ->
            val time = parseSlot(slot)?.let { LocalTime.of(it / 60, it % 60) } ?: return@mapNotNull null
            val original = date.atTime(time).atZone(zone).toInstant().toEpochMilli()
            val offset = randomOffsetMinutes(schedule.scheduleId, date, slot, schedule.randomizeMinutes)
            val promptAt = original + offset * MINUTE
            PromptOccurrence(
                id = occurrenceId(schedule.scheduleId, date, slot),
                scheduleId = schedule.scheduleId,
                date = date,
                slot = slot,
                originalAtMillis = original,
                promptAtMillis = promptAt,
                expiresAtMillis = expiresAt(schedule, date, original, promptAt, zone),
            )
        }
    }

    /** Occurrences whose (randomized) prompt time falls in [fromMillis, toMillis]. */
    fun occurrencesBetween(schedule: PromptSchedule, fromMillis: Long, toMillis: Long, zone: ZoneId): List<PromptOccurrence> {
        if (toMillis < fromMillis) return emptyList()
        // One extra day on each side: a random offset can cross midnight.
        var date = Instant.ofEpochMilli(fromMillis).atZone(zone).toLocalDate().minusDays(1)
        val lastDate = Instant.ofEpochMilli(toMillis).atZone(zone).toLocalDate().plusDays(1)
        val result = mutableListOf<PromptOccurrence>()
        while (!date.isAfter(lastDate)) {
            occurrencesOn(schedule, date, zone)
                .filterTo(result) { it.promptAtMillis in fromMillis..toMillis }
            date = date.plusDays(1)
        }
        return result.sortedBy { it.promptAtMillis }
    }

    /**
     * Decides what a worker run should do. Occurrences already present in
     * [records] are never delivered again. Only the newest open occurrence of
     * each schedule is delivered; older ones the device slept through are
     * reported as missed rather than stacked up as several notifications.
     */
    fun plan(
        schedules: List<PromptSchedule>,
        records: Map<String, OccurrenceRecord>,
        nowMillis: Long,
        floorMillis: Long,
        zone: ZoneId,
    ): PromptPlan {
        val deliver = mutableListOf<PromptOccurrence>()
        val missed = mutableListOf<PromptOccurrence>()
        val from = maxOf(floorMillis, nowMillis - LOOKBACK_MILLIS)
        for (schedule in schedules) {
            val pending = occurrencesBetween(schedule, from, nowMillis, zone)
                .filter { it.id !in records }
            val open = pending.filter { nowMillis < it.expiresAtMillis }
            val newest = open.maxByOrNull { it.promptAtMillis }
            if (newest != null) deliver += newest
            missed += pending.filter { it !== newest }
        }
        val expire = records.values.filter {
            it.status == OccurrenceStatus.DELIVERED && it.expiresAtMillis <= nowMillis
        }
        return PromptPlan(
            deliver = deliver.sortedBy { it.promptAtMillis },
            expire = expire.sortedBy { it.promptAtMillis },
            missed = missed.sortedBy { it.promptAtMillis },
        )
    }

    /**
     * AWARE measures expiration from the original (unrandomized) slot time; a
     * zero expiration means "no expiry", which here closes the prompt at the
     * end of its local day so it can still be recorded as expired.
     */
    private fun expiresAt(schedule: PromptSchedule, date: LocalDate, original: Long, promptAt: Long, zone: ZoneId): Long {
        if (schedule.expirationMinutes <= 0) {
            val endOfDay = date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            return maxOf(endOfDay, promptAt + MINUTE)
        }
        val fromOriginal = original + schedule.expirationMinutes * MINUTE
        return if (fromOriginal > promptAt) fromOriginal else promptAt + schedule.expirationMinutes * MINUTE
    }

    /** Minutes after midnight for "H", "HH", "H:MM" or "HH:MM"; null if invalid. */
    private fun parseSlot(value: String): Int? {
        val match = Regex("""^(\d{1,2})(?::(\d{1,2}))?$""").matchEntire(value.trim()) ?: return null
        val hour = match.groupValues[1].toInt()
        val minute = match.groupValues[2].ifEmpty { "0" }.toInt()
        if (hour !in 0..23 || minute !in 0..59) return null
        return hour * 60 + minute
    }

    /** FNV-1a 64-bit: stable across processes and JVMs, unlike identity hashes. */
    private fun stableHash(value: String): Long {
        var hash = -0x340d631b7bdddcdbL
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (byte.toLong() and 0xff)
            hash *= 0x100000001b3L
        }
        return hash
    }

    private const val MINUTE = 60_000L
}
