package edu.studytrace.android

import android.content.Context
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import java.io.File
import java.security.MessageDigest

/** Photos live in private draft files, never in the activity's saved-state Bundle. */
object SurveyDrafts {
    private fun directory(context: Context) = File(context.filesDir, "survey_drafts")
    private fun file(context: Context, id: String): File {
        val scope = StudyPrefs(context).studyUrl + "|" + id
        val hash = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it) }
        return File(directory(context).apply { mkdirs() }, "$hash.json")
    }
    fun read(context: Context, id: String): JSONArray = runCatching { JSONArray(file(context, id).readText()) }.getOrDefault(JSONArray())
    fun save(context: Context, id: String, answers: List<String>) {
        val target = file(context, id)
        val pending = File(target.path + ".tmp")
        pending.writeText(JSONArray(answers).toString())
        check(pending.renameTo(target)) { "Could not save the survey draft. Please try again." }
    }
    fun delete(context: Context, id: String) { file(context, id).delete() }
    fun clear(context: Context) { directory(context).deleteRecursively(); File(context.cacheDir, "survey_camera").deleteRecursively() }
}

class SurveyPhotoAnswerView(context: Context, initialAnswer: String, choose: () -> Unit, camera: () -> Unit) : LinearLayout(context) {
    private val images = runCatching { JSONArray(initialAnswer) }.getOrDefault(JSONArray())
    val answer: String get() = if (images.length() == 0) "" else images.toString()
    init {
        orientation = VERTICAL
        addView(TextView(context).apply { text = "Attach up to 10 photos. You can choose existing photos or take pictures." })
        val photos = LinearLayout(context).apply { orientation = VERTICAL }
        fun refresh() {
            photos.removeAllViews()
            for (index in 0 until images.length()) {
                photos.addView(Button(context).apply {
                    text = "Photo ${index + 1} attached · Remove"
                    contentDescription = "Remove attached photo ${index + 1}"
                    setOnClickListener { images.remove(index); refresh() }
                })
            }
        }
        refresh()
        addView(photos)
        addView(Button(context).apply { text = "Choose photos"; setOnClickListener { choose() } })
        addView(Button(context).apply { text = "Take a photo"; setOnClickListener { camera() } })
    }
}
