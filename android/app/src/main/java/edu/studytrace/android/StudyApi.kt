package edu.studytrace.android

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class StudyApi(private val context: Context) {
    private val prefs = StudyPrefs(context)

    fun currentContext(): StudyContext? = parseStudyContext(prefs.studyUrl)

    fun joinStudy(): Boolean = currentContext()?.let(::joinStudy) ?: false

    fun joinStudy(study: StudyContext): Boolean {
        val body = "device_id=${URLEncoder.encode(prefs.deviceId, Charsets.UTF_8.name())}"
        val response = request(
            url = study.normalizedStudyUrl,
            method = "POST",
            body = body,
            contentType = "application/x-www-form-urlencoded",
            bearer = null,
        )
        return response.code in 200..299
    }

    /**
     * Posts one batch to the generic insert endpoint and returns the HTTP
     * status, or [UploadPolicy.NETWORK_ERROR]. Callers go through
     * [UploadQueue]; rows carry event_id/dedupe_key so retries are safe.
     */
    fun postRowsStatus(sensor: String, rows: List<JSONObject>): Int {
        if (rows.isEmpty()) return 200
        val study = currentContext() ?: return UploadPolicy.NETWORK_ERROR
        val payload = JSONObject()
            .put("device_id", prefs.deviceId)
            .put("rows", JSONArray(rows))
        val target = "${study.baseUrl}/api/v1/studies/${encodePath(study.studyId)}/sensors/${encodePath(sensor)}/data"
        val response = request(
            url = target,
            method = "POST",
            body = payload.toString(),
            contentType = "application/json",
            bearer = study.password,
        )
        if (response.code in 200..299) {
            prefs.lastSyncMillis = System.currentTimeMillis()
        }
        return response.code
    }

    /**
     * Participant survey configuration: a JSON array of ESM and screenshot
     * prompt schedules. The `/api/v1/.../esm-schedule` routes are
     * researcher-only, so this uses the study-URL route. Null on failure.
     */
    fun fetchSurveyConfig(): JSONArray? {
        val study = currentContext() ?: return null
        val target = "${study.baseUrl}/index.php/webservice/index/" +
            "${encodePath(study.studyId)}/${encodePath(study.password)}/esm/config"
        val response = request(
            url = target,
            method = "GET",
            body = null,
            contentType = null,
            bearer = null,
        )
        if (response.code !in 200..299 || response.body.isBlank()) return null
        return runCatching { JSONArray(response.body) }.getOrNull()
    }

    /** Sends a stored withdrawal request; uses its own credentials since study settings are already cleared. */
    fun postWithdrawal(request: PendingWithdrawal): Int {
        val payload = JSONObject()
            .put("device_id", request.deviceId)
            .put("delete_data", request.deleteData)
            .put("withdrawn_at", request.withdrawnAtMillis)
        val target = "${request.baseUrl}/api/v1/studies/${encodePath(request.studyId)}/withdrawal"
        return request(
            url = target,
            method = "POST",
            body = payload.toString(),
            contentType = "application/json",
            bearer = request.password,
        ).code
    }

    private fun request(
        url: String,
        method: String,
        body: String?,
        contentType: String?,
        bearer: String?,
    ): HttpResponse {
        var connection: HttpURLConnection? = null
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Accept", "application/json")
                if (contentType != null) setRequestProperty("Content-Type", contentType)
                if (!bearer.isNullOrBlank()) setRequestProperty("Authorization", "Bearer $bearer")
                if (body != null) doOutput = true
            }
            connection = conn
            if (body != null) {
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..399) conn.inputStream else conn.errorStream
            val text = stream?.let {
                BufferedReader(InputStreamReader(it, Charsets.UTF_8)).use(BufferedReader::readText)
            } ?: ""
            HttpResponse(code, text)
        } catch (_: IOException) {
            HttpResponse(UploadPolicy.NETWORK_ERROR, "")
        } finally {
            connection?.disconnect()
        }
    }

    private data class HttpResponse(val code: Int, val body: String)
}
