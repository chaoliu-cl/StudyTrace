package edu.studytrace.android

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.Locale

/**
 * Persistent upload buffer shared by every collector.
 *
 * Layout: filesDir/upload_queue/<sensor>/active.jsonl receives appended rows
 * (one JSON object per line). A drain first "seals" the active file into
 * batch-*.jsonl files of at most [MAX_BATCH_ROWS] rows, then posts each batch
 * and deletes it once the server accepts it. Appenders only ever touch
 * active.jsonl, so a drain in progress never loses rows appended meanwhile.
 * Batches survive process death and are retried by the next SyncWorker run.
 */
object UploadQueue {
    const val MAX_BATCH_ROWS = 500

    /** Oldest batches beyond this (per sensor) are discarded to bound storage. */
    private const val MAX_BATCHES_PER_SENSOR = 400
    private const val ACTIVE_FILE = "active.jsonl"
    private const val BATCH_PREFIX = "batch-"

    /** Guards file mutation (append, seal, purge). */
    private val fileLock = Any()

    /** Only one drain at a time, so a batch is never posted and deleted twice. */
    private val drainLock = Any()
    private var batchCounter = 0

    enum class DrainResult { COMPLETE, RETRY, NOT_JOINED }

    fun enqueue(context: Context, sensor: String, row: JSONObject) = enqueue(context, sensor, listOf(row))

    /** Appends rows for [sensor]. Dropped when the participant has not consented (e.g. after withdrawal). */
    fun enqueue(context: Context, sensor: String, rows: List<JSONObject>) {
        if (rows.isEmpty()) return
        val text = rows.joinToString(separator = "\n", postfix = "\n") { it.toString() }
        synchronized(fileLock) {
            // Recheck while holding the mutation lock. A study switch sets these false
            // before purge, so an appender cannot recreate old-study data after purge.
            val prefs = StudyPrefs(context)
            if (!prefs.consentGranted || !prefs.enrollmentConfirmed) return
            val dir = sensorDir(context, sensor)
            dir.mkdirs()
            File(dir, ACTIVE_FILE).appendText(text, Charsets.UTF_8)
        }
    }

    fun pendingCount(context: Context): Int =
        synchronized(fileLock) {
            sensorDirs(context).sumOf { dir ->
                dir.listFiles()?.sumOf { file -> countLines(file) } ?: 0
            }
        }

    /**
     * Uploads everything queued. Returns [DrainResult.RETRY] on a network
     * error, 408/429 or 5xx (remaining batches stay queued). Batches rejected
     * with any other 4xx are dropped and counted in [StudyPrefs.droppedUploadRows].
     */
    fun drain(context: Context, api: StudyApi = StudyApi(context)): DrainResult =
        synchronized(drainLock) {
            val prefs = StudyPrefs(context)
            if (!prefs.consentGranted || !prefs.enrollmentConfirmed || api.currentContext() == null) {
                return@synchronized DrainResult.NOT_JOINED
            }
            for (dir in sensorDirs(context)) {
                val sensor = dir.name
                for (batch in sealAndListBatches(context, dir)) {
                    // Withdrawal clears consent and purges the queue mid-drain.
                    if (!prefs.consentGranted) return@synchronized DrainResult.NOT_JOINED
                    val rows = readRows(batch) ?: continue
                    if (rows.isEmpty()) {
                        batch.delete()
                        continue
                    }
                    when (UploadPolicy.classify(api.postRowsStatus(sensor, rows))) {
                        UploadOutcome.SUCCESS -> batch.delete()
                        UploadOutcome.DROP -> {
                            batch.delete()
                            prefs.addDroppedUploadRows(rows.size)
                        }
                        UploadOutcome.RETRY -> return@synchronized DrainResult.RETRY
                    }
                }
            }
            DrainResult.COMPLETE
        }

    /** Deletes everything queued (withdrawal or a confirmed switch to another study). */
    fun purge(context: Context) {
        synchronized(drainLock) {
            synchronized(fileLock) {
                rootDir(context).deleteRecursively()
            }
        }
    }

    private fun sealAndListBatches(context: Context, dir: File): List<File> =
        synchronized(fileLock) {
            val active = File(dir, ACTIVE_FILE)
            if (active.exists()) {
                val lines = runCatching { active.readLines(Charsets.UTF_8) }.getOrDefault(emptyList())
                    .filter { it.isNotBlank() }
                lines.chunked(MAX_BATCH_ROWS).forEach { chunk ->
                    val name = "%s%013d-%06d.jsonl".format(
                        Locale.US,
                        BATCH_PREFIX,
                        System.currentTimeMillis(),
                        batchCounter++ % 1_000_000,
                    )
                    File(dir, name).writeText(chunk.joinToString(separator = "\n", postfix = "\n"), Charsets.UTF_8)
                }
                active.delete()
            }
            val batches = dir.listFiles { file -> file.name.startsWith(BATCH_PREFIX) }
                ?.sortedBy { it.name }
                .orEmpty()
            val overflow = batches.size - MAX_BATCHES_PER_SENSOR
            if (overflow > 0) {
                var dropped = 0
                batches.take(overflow).forEach { dropped += countLines(it); it.delete() }
                StudyPrefs(context).addDroppedUploadRows(dropped)
                batches.drop(overflow)
            } else {
                batches
            }
        }

    private fun readRows(batch: File): List<JSONObject>? {
        val lines = runCatching { batch.readLines(Charsets.UTF_8) }.getOrNull() ?: return null
        // A malformed line (e.g. torn write) is skipped rather than blocking the batch forever.
        return lines.filter { it.isNotBlank() }.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
    }

    private fun countLines(file: File): Int =
        runCatching { file.useLines(Charsets.UTF_8) { lines -> lines.count { it.isNotBlank() } } }.getOrDefault(0)

    private fun rootDir(context: Context): File = File(context.applicationContext.filesDir, "upload_queue")

    private fun sensorDir(context: Context, sensor: String): File =
        File(rootDir(context), sensor.replace(Regex("[^A-Za-z0-9_]"), "_"))

    private fun sensorDirs(context: Context): List<File> =
        rootDir(context).listFiles { file -> file.isDirectory }?.sortedBy { it.name }.orEmpty()
}
