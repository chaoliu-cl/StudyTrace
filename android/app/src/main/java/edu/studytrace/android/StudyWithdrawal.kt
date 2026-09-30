package edu.studytrace.android

import android.content.Context
import android.content.Intent
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** A withdrawal the server has not acknowledged yet, with the credentials needed to send it later. */
data class PendingWithdrawal(
    val baseUrl: String,
    val studyId: String,
    val password: String,
    val deviceId: String,
    val deleteData: Boolean,
    val withdrawnAtMillis: Long,
) {
    fun toJson(): String =
        JSONObject()
            .put("base_url", baseUrl)
            .put("study_id", studyId)
            .put("password", password)
            .put("device_id", deviceId)
            .put("delete_data", deleteData)
            .put("withdrawn_at", withdrawnAtMillis)
            .toString()

    companion object {
        fun fromJson(raw: String): PendingWithdrawal? {
            if (raw.isBlank()) return null
            val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
            return PendingWithdrawal(
                baseUrl = json.optString("base_url").ifBlank { return null },
                studyId = json.optString("study_id").ifBlank { return null },
                password = json.optString("password").ifBlank { return null },
                deviceId = json.optString("device_id").ifBlank { return null },
                deleteData = json.optBoolean("delete_data", false),
                withdrawnAtMillis = json.optLong("withdrawn_at", System.currentTimeMillis()),
            )
        }
    }
}

/**
 * Leaving a study, mirroring the iOS client: stop collection, cancel prompts,
 * delete study data kept on the phone, then tell the server (queued and
 * retried with the original withdrawn_at when offline).
 */
object StudyWithdrawal {
    enum class SendResult { SENT, PENDING, NONE }

    /** Local cleanup; returns true if a server request was stored for sending. Does no network I/O. */
    fun leave(context: Context, deleteUploadedData: Boolean): Boolean {
        val prefs = StudyPrefs(context)
        val study = parseStudyContext(prefs.studyUrl)
        val request = study?.let {
            PendingWithdrawal(
                baseUrl = it.baseUrl,
                studyId = it.studyId,
                password = it.password,
                deviceId = prefs.deviceId,
                deleteData = deleteUploadedData,
                withdrawnAtMillis = System.currentTimeMillis(),
            )
        }
        if (request != null) prefs.pendingWithdrawal = request.toJson()

        // Clearing consent first makes collectors and in-flight workers drop new rows.
        prefs.consentGranted = false
        prefs.locationTrackingEnabled = false
        context.stopService(Intent(context, LocationTrackingService::class.java))
        SyncWorker.cancel(context)
        NotificationHelper.cancelAll(context)
        UploadQueue.purge(context)
        SurveyRepository.clear(context)
        prefs.clearStudy()
        // The caller sends right away (sendPending). The delayed worker is the
        // fallback if that fails or the process dies first; it is a no-op once
        // the request has been accepted.
        if (request != null) WithdrawalWorker.enqueue(context, replace = true, delayMinutes = 1)
        return request != null
    }

    /** Sends the pending withdrawal, if any. Network call. */
    fun sendPending(context: Context): SendResult {
        val prefs = StudyPrefs(context)
        val request = PendingWithdrawal.fromJson(prefs.pendingWithdrawal)
        if (request == null) {
            prefs.pendingWithdrawal = ""
            return SendResult.NONE
        }
        return when (UploadPolicy.classify(StudyApi(context).postWithdrawal(request))) {
            UploadOutcome.SUCCESS -> {
                clearIfSame(prefs, request)
                SendResult.SENT
            }
            // Rejected for good (e.g. the study no longer exists): nothing left to retry.
            UploadOutcome.DROP -> {
                clearIfSame(prefs, request)
                SendResult.NONE
            }
            UploadOutcome.RETRY -> SendResult.PENDING
        }
    }

    fun hasPending(context: Context): Boolean = StudyPrefs(context).pendingWithdrawal.isNotBlank()

    private fun clearIfSame(prefs: StudyPrefs, request: PendingWithdrawal) {
        // A newer withdrawal (after a re-join) may have replaced this one meanwhile.
        if (PendingWithdrawal.fromJson(prefs.pendingWithdrawal) == request) prefs.pendingWithdrawal = ""
    }
}

class WithdrawalWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        when (StudyWithdrawal.sendPending(applicationContext)) {
            StudyWithdrawal.SendResult.PENDING -> Result.retry()
            else -> Result.success()
        }
    }

    companion object {
        private const val WORK_NAME = "studytrace_withdrawal"

        /** [replace] restarts backoff for a new request; otherwise an already queued retry is kept. */
        fun enqueue(context: Context, replace: Boolean = false, delayMinutes: Long = 0) {
            val request = OneTimeWorkRequestBuilder<WithdrawalWorker>()
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME,
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}
