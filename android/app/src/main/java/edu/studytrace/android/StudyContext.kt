package edu.studytrace.android

import android.net.Uri
import java.net.URLEncoder

data class StudyContext(
    val normalizedStudyUrl: String,
    val baseUrl: String,
    val studyId: String,
    val password: String,
)

fun parseStudyContext(rawUrl: String): StudyContext? {
    val normalized = normalizeStudyUrl(rawUrl) ?: return null
    val uri = Uri.parse(normalized)
    if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrBlank()) return null

    val segments = uri.pathSegments
    val index = segments.indexOfLast { it == "index" }
    if (index < 0 || segments.size <= index + 2) return null

    val port = if (uri.port > 0) ":${uri.port}" else ""
    return StudyContext(
        normalizedStudyUrl = normalized,
        baseUrl = "https://${uri.host}$port",
        studyId = segments[index + 1],
        password = segments[index + 2],
    )
}

/**
 * Accepts a pasted/scanned study URL: https, AWARE's aware:// and
 * aware-ssl:// forms (upgraded to https), or the app's own deep link
 * `studytrace://join?url=<https study URL>`.
 */
fun normalizeStudyUrl(rawUrl: String): String? {
    val trimmed = rawUrl.trim()
    if (trimmed.isBlank()) return null
    return when {
        trimmed.startsWith("studytrace://", ignoreCase = true) -> {
            val inner = runCatching { Uri.parse(trimmed).getQueryParameter("url") }.getOrNull()
            // Only one level of wrapping, and the wrapped URL must itself be https.
            inner?.trim()?.takeIf { it.startsWith("https://", ignoreCase = true) }
        }
        trimmed.startsWith("aware-ssl://", ignoreCase = true) ->
            "https://" + trimmed.substringAfter("://")
        trimmed.startsWith("aware://", ignoreCase = true) ->
            "https://" + trimmed.substringAfter("://")
        trimmed.startsWith("https://", ignoreCase = true) -> trimmed
        else -> null
    }
}

/** QR invitations may omit the scheme, as on iOS; only valid HTTPS study URLs survive. */
fun normalizeScannedStudyUrl(rawValue: String): String? {
    val trimmed = rawValue.trim()
    val candidate = if (!trimmed.contains("://") && trimmed.contains('.') && trimmed.none(Char::isWhitespace)) {
        "https://$trimmed"
    } else {
        trimmed
    }
    val normalized = normalizeStudyUrl(candidate) ?: return null
    return normalized.takeIf { parseStudyContext(it) != null }
}

fun encodePath(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
