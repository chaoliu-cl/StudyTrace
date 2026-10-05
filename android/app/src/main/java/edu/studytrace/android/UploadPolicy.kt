package edu.studytrace.android

/** What to do with a queued batch after an upload attempt. Pure, for unit tests. */
enum class UploadOutcome { SUCCESS, RETRY, DROP }

object UploadPolicy {
    /** HTTP status used by StudyApi when the request never got a response. */
    const val NETWORK_ERROR = -1

    /**
     * 2xx is success. Network errors, 408, 429, 5xx and anything unexpected
     * are retried (the server dedupes rows, so re-sending is safe). Other 4xx
     * responses will never succeed for this payload, so the batch is dropped.
     */
    fun classify(code: Int): UploadOutcome =
        when {
            code in 200..299 -> UploadOutcome.SUCCESS
            code == 408 || code == 429 -> UploadOutcome.RETRY
            code in 400..499 -> UploadOutcome.DROP
            else -> UploadOutcome.RETRY
        }
}
