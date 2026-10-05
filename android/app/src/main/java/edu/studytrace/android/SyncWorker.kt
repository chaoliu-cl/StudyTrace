package edu.studytrace.android

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Runs about every 15 minutes: telemetry, completed-day app usage, screen
 * events, survey prompts (from the cached config when offline), then drains
 * the upload queue. Returns retry when the queue could not be fully sent.
 */
class SyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        val prefs = StudyPrefs(context)
        if (!prefs.consentGranted || !prefs.enrollmentConfirmed || parseStudyContext(prefs.studyUrl) == null) {
            return@withContext Result.success()
        }
        runCatching {
            Telemetry.recordHeartbeatIfDue(context, "sync_worker")
            Telemetry.recordDeviceState(context, "periodic_sync")
            UsageStatsCollector.collectPending(context)
        }
        runCatching {
            SurveyRepository.refreshConfig(context)
            SurveyRepository.runScheduler(context)
        }
        val drained = runCatching { UploadQueue.drain(context) }.getOrDefault(UploadQueue.DrainResult.RETRY)
        if (drained == UploadQueue.DrainResult.RETRY) Result.retry() else Result.success()
    }

    companion object {
        private const val WORK_NAME = "studytrace_periodic_sync"

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
