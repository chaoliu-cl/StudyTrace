package edu.studytrace.android

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.ZoneId

/**
 * Survey prompts on Android. The participant config comes from
 * `.../index/{study}/{password}/esm/config` and is cached so prompts keep
 * firing offline. [runScheduler] (called by the 15-minute SyncWorker) turns
 * each schedule into concrete occurrences via [PromptPlanner], notifies each
 * occurrence exactly once, and records expired/dismissed/answered outcomes as
 * `plugin_ios_esm` rows (AWARE esm_status 3/1/2).
 */
object SurveyRepository {
    const val ESM_SENSOR = "plugin_ios_esm"
    const val ESM_STATUS_DISMISSED = 1
    const val ESM_STATUS_ANSWERED = 2
    const val ESM_STATUS_EXPIRED = 3

    private const val PREFS_NAME = "studytrace_surveys"
    private const val KEY_CONFIG = "config_json"
    private const val KEY_RECORDS = "occurrences_json"
    private const val RECORD_RETENTION_MILLIS = 7L * 24L * 60L * 60L * 1000L

    private val lock = Any()

    /** A delivered prompt the participant can still answer. */
    data class OpenPrompt(val record: OccurrenceRecord, val schedule: JSONObject) {
        val title: String get() = schedule.optString("notification_title", "StudyTrace survey")
    }

    /** Fetches and caches the participant config; falls back to the cache when offline. Network call. */
    fun refreshConfig(context: Context): JSONArray {
        val fetched = StudyApi(context).fetchSurveyConfig()
        if (fetched != null) {
            prefs(context).edit().putString(KEY_CONFIG, fetched.toString()).apply()
            return fetched
        }
        return cachedConfig(context)
    }

    fun cachedConfig(context: Context): JSONArray =
        prefs(context).getString(KEY_CONFIG, null)
            ?.let { runCatching { JSONArray(it) }.getOrNull() }
            ?: JSONArray()

    /** Schedules Android should prompt for (iOS screenshot prompt types are skipped). */
    fun surveySchedules(config: JSONArray): List<Pair<PromptSchedule, JSONObject>> {
        val result = mutableListOf<Pair<PromptSchedule, JSONObject>>()
        val seen = mutableSetOf<String>()
        for (i in 0 until config.length()) {
            val json = config.optJSONObject(i) ?: continue
            val schedule = parseSchedule(json) ?: continue
            if (!PromptPlanner.isAndroidSurvey(json.optString("studytrace_prompt_type"), schedule.scheduleId)) continue
            if (!seen.add(schedule.scheduleId)) continue
            result += schedule to json
        }
        return result
    }

    fun parseSchedule(json: JSONObject): PromptSchedule? {
        val scheduleId = json.optString("schedule_id").trim()
        if (scheduleId.isEmpty()) return null
        val times = json.optJSONArray("times")?.let { array ->
            (0 until array.length()).map { array.optString(it) }
        }.orEmpty()
        val hours = json.optJSONArray("hours")?.let { array ->
            (0 until array.length()).map { array.optInt(it, -1) }
        }.orEmpty()
        return PromptSchedule(
            scheduleId = scheduleId,
            slots = PromptPlanner.normalizeSlots(times, hours),
            randomizeMinutes = json.optInt("randomize", 0).coerceAtLeast(0),
            expirationMinutes = json.optInt("expiration", 0).coerceAtLeast(0),
            startDate = PromptPlanner.parseScheduleDate(json.optString("start_date")),
            endDate = PromptPlanner.parseScheduleDate(json.optString("end_date")),
        )
    }

    /** Delivers due prompts, records missed and expired ones. Returns the number delivered. */
    fun runScheduler(context: Context, nowMillis: Long = System.currentTimeMillis()): Int =
        synchronized(lock) {
            val studyPrefs = StudyPrefs(context)
            if (!studyPrefs.consentGranted || !studyPrefs.enrollmentConfirmed ||
                parseStudyContext(studyPrefs.studyUrl) == null
            ) return@synchronized 0
            if (studyPrefs.joinedAtMillis <= 0L) studyPrefs.joinedAtMillis = nowMillis

            val schedules = surveySchedules(cachedConfig(context))
            val scheduleJson = schedules.associate { it.first.scheduleId to it.second }
            val records = loadRecords(context)
            val plan = PromptPlanner.plan(
                schedules = schedules.map { it.first },
                records = records,
                nowMillis = nowMillis,
                floorMillis = studyPrefs.joinedAtMillis,
                zone = ZoneId.systemDefault(),
            )
            val notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()

            for (occurrence in plan.deliver) {
                val json = scheduleJson[occurrence.scheduleId] ?: continue
                val record = OccurrenceRecord(
                    id = occurrence.id,
                    scheduleId = occurrence.scheduleId,
                    status = OccurrenceStatus.DELIVERED,
                    promptAtMillis = occurrence.promptAtMillis,
                    deliveredAtMillis = nowMillis,
                    expiresAtMillis = occurrence.expiresAtMillis,
                )
                records[occurrence.id] = record
                saveRecords(context, records)
                NotificationHelper.showSurveyNotification(
                    context,
                    occurrence.id,
                    json.optString("notification_title"),
                    json.optString("notification_body"),
                )
                Telemetry.recordEvent(
                    context,
                    "notification_delivered",
                    promptMetadata(record, json)
                        .put("notifications_enabled", notificationsEnabled)
                        .put("delay_minutes", (nowMillis - occurrence.promptAtMillis) / 60_000),
                    eventId = Telemetry.stableEventId("notification_delivered|${occurrence.id}"),
                )
            }

            for (occurrence in plan.missed) {
                records[occurrence.id] = OccurrenceRecord(
                    id = occurrence.id,
                    scheduleId = occurrence.scheduleId,
                    status = OccurrenceStatus.MISSED,
                    promptAtMillis = occurrence.promptAtMillis,
                    deliveredAtMillis = 0L,
                    expiresAtMillis = occurrence.expiresAtMillis,
                )
                // Not a survey prompt event: the participant never saw it.
                Telemetry.recordEvent(
                    context,
                    "survey_prompt_missed",
                    JSONObject()
                        .put("notification_id", occurrence.id)
                        .put("schedule_id", occurrence.scheduleId)
                        .put("scheduled_at", occurrence.promptAtMillis)
                        .put("expires_at", occurrence.expiresAtMillis),
                    eventId = Telemetry.stableEventId("survey_prompt_missed|${occurrence.id}"),
                )
            }

            for (record in plan.expire) {
                resolve(context, records, record, scheduleJson[record.scheduleId], ESM_STATUS_EXPIRED, null, nowMillis)
            }

            records.values.removeAll { maxOf(it.promptAtMillis, it.expiresAtMillis) < nowMillis - RECORD_RETENTION_MILLIS }
            saveRecords(context, records)
            plan.deliver.size
        }

    /** Delivered prompts still inside their window, newest first. */
    fun openPrompts(context: Context, nowMillis: Long = System.currentTimeMillis()): List<OpenPrompt> =
        synchronized(lock) {
            val scheduleJson = surveySchedules(cachedConfig(context)).associate { it.first.scheduleId to it.second }
            loadRecords(context).values
                .filter { it.status == OccurrenceStatus.DELIVERED && it.expiresAtMillis > nowMillis }
                .mapNotNull { record -> scheduleJson[record.scheduleId]?.let { OpenPrompt(record, it) } }
                .sortedByDescending { it.record.promptAtMillis }
        }

    /**
     * The prompt for a tapped notification, or null if it was already
     * answered/dismissed. A prompt past its window is recorded as expired.
     */
    fun openPrompt(context: Context, occurrenceId: String, nowMillis: Long = System.currentTimeMillis()): OpenPrompt? =
        synchronized(lock) {
            val records = loadRecords(context)
            val record = records[occurrenceId] ?: return@synchronized null
            if (record.status != OccurrenceStatus.DELIVERED) return@synchronized null
            val json = surveySchedules(cachedConfig(context)).firstOrNull { it.first.scheduleId == record.scheduleId }?.second
            if (record.expiresAtMillis <= nowMillis || json == null) {
                resolve(context, records, record, json, ESM_STATUS_EXPIRED, null, nowMillis)
                saveRecords(context, records)
                return@synchronized null
            }
            OpenPrompt(record, json)
        }

    fun recordTapped(context: Context, occurrenceId: String) {
        val record = synchronized(lock) { loadRecords(context)[occurrenceId] } ?: return
        val json = surveySchedules(cachedConfig(context)).firstOrNull { it.first.scheduleId == record.scheduleId }?.second
        Telemetry.recordEvent(context, "notification_tapped", promptMetadata(record, json))
    }

    /** Queues answer rows (esm_status 2). False if the prompt was already resolved. */
    fun submitAnswers(context: Context, occurrenceId: String, answers: List<Pair<JSONObject, String>>): Boolean =
        resolveById(context, occurrenceId, ESM_STATUS_ANSWERED, answers)

    /** Queues dismissed rows (esm_status 1) when the participant closes a prompt without answering. */
    fun dismiss(context: Context, occurrenceId: String): Boolean =
        resolveById(context, occurrenceId, ESM_STATUS_DISMISSED, null)

    fun allQuestions(schedule: JSONObject): List<JSONObject> {
        val esms = schedule.optJSONArray("esms") ?: JSONArray()
        val questions = mutableListOf<JSONObject>()
        for (i in 0 until esms.length()) {
            val wrapper = esms.optJSONObject(i) ?: continue
            questions += wrapper.optJSONObject("esm") ?: wrapper
        }
        return questions
    }

    /** Removes cached config and prompt state (withdrawal). */
    fun clear(context: Context) {
        synchronized(lock) { prefs(context).edit().clear().apply() }
    }

    private fun resolveById(context: Context, occurrenceId: String, status: Int, answers: List<Pair<JSONObject, String>>?): Boolean =
        synchronized(lock) {
            val records = loadRecords(context)
            val record = records[occurrenceId] ?: return@synchronized false
            if (record.status != OccurrenceStatus.DELIVERED) return@synchronized false
            val json = surveySchedules(cachedConfig(context)).firstOrNull { it.first.scheduleId == record.scheduleId }?.second
            resolve(context, records, record, json, status, answers, System.currentTimeMillis())
            saveRecords(context, records)
            true
        }

    private fun resolve(
        context: Context,
        records: MutableMap<String, OccurrenceRecord>,
        record: OccurrenceRecord,
        schedule: JSONObject?,
        esmStatus: Int,
        answers: List<Pair<JSONObject, String>>?,
        nowMillis: Long,
    ) {
        val status = when (esmStatus) {
            ESM_STATUS_ANSWERED -> OccurrenceStatus.ANSWERED
            ESM_STATUS_DISMISSED -> OccurrenceStatus.DISMISSED
            else -> OccurrenceStatus.EXPIRED
        }
        records[record.id] = record.copy(status = status)
        NotificationHelper.cancelSurveyNotification(context, record.id)
        UploadQueue.enqueue(context, ESM_SENSOR, esmRows(record, schedule, esmStatus, answers, nowMillis))
    }

    private fun esmRows(
        record: OccurrenceRecord,
        schedule: JSONObject?,
        esmStatus: Int,
        answers: List<Pair<JSONObject, String>>?,
        nowMillis: Long,
    ): List<JSONObject> {
        val items: List<Pair<JSONObject, String>> = answers
            ?: schedule?.let { allQuestions(it) }.orEmpty().map { it to "" }
                .ifEmpty { listOf(JSONObject() to "") }
        val promptTime = if (record.deliveredAtMillis > 0) record.deliveredAtMillis else record.promptAtMillis
        val answerTime = if (esmStatus == ESM_STATUS_EXPIRED) 0L else nowMillis
        return items.mapIndexed { index, (question, answer) ->
            Telemetry.zoneFields(JSONObject(), promptTime)
                .put("timestamp", promptTime)
                .put("event_id", Telemetry.stableEventId("esm|${record.id}|$index|$esmStatus"))
                .put("schedule_id", record.scheduleId)
                .put("notification_id", record.id)
                .put("esm_trigger", question.optString("esm_trigger", "android_q${index + 1}"))
                .put("esm_json", question.toString())
                .put("esm_user_answer", answer)
                .put("double_esm_user_answer_timestamp", answerTime)
                .put("esm_status", esmStatus)
                .put("esm_expiration_threshold", ((record.expiresAtMillis - record.promptAtMillis) / 1000).coerceAtLeast(0))
        }
    }

    private fun promptMetadata(record: OccurrenceRecord, schedule: JSONObject?): JSONObject =
        JSONObject()
            .put("notification_id", record.id)
            .put("delivered_at", record.deliveredAtMillis)
            .put("is_survey_prompt", true)
            .put("schedule_id", record.scheduleId)
            .put("scheduled_at", record.promptAtMillis)
            .put("expires_at", record.expiresAtMillis)
            .put("title", schedule?.optString("notification_title").orEmpty())

    private fun loadRecords(context: Context): MutableMap<String, OccurrenceRecord> {
        val result = mutableMapOf<String, OccurrenceRecord>()
        val raw = prefs(context).getString(KEY_RECORDS, null) ?: return result
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return result
        json.keys().forEach { id ->
            val item = json.optJSONObject(id) ?: return@forEach
            val status = runCatching { OccurrenceStatus.valueOf(item.optString("status")) }.getOrNull() ?: return@forEach
            result[id] = OccurrenceRecord(
                id = id,
                scheduleId = item.optString("schedule_id"),
                status = status,
                promptAtMillis = item.optLong("prompt_at"),
                deliveredAtMillis = item.optLong("delivered_at"),
                expiresAtMillis = item.optLong("expires_at"),
            )
        }
        return result
    }

    private fun saveRecords(context: Context, records: Map<String, OccurrenceRecord>) {
        val json = JSONObject()
        records.values.forEach { record ->
            json.put(
                record.id,
                JSONObject()
                    .put("schedule_id", record.scheduleId)
                    .put("status", record.status.name)
                    .put("prompt_at", record.promptAtMillis)
                    .put("delivered_at", record.deliveredAtMillis)
                    .put("expires_at", record.expiresAtMillis),
            )
        }
        prefs(context).edit().putString(KEY_RECORDS, json.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
