package edu.studytrace.android

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import android.app.Activity
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

class MainActivity : Activity() {
    private lateinit var prefs: StudyPrefs
    private lateinit var studyUrlEdit: EditText
    private lateinit var consentCheck: CheckBox
    private lateinit var statusText: TextView
    private lateinit var surveyList: LinearLayout
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = StudyPrefs(this)
        NotificationHelper.ensureChannels(this)
        if (isJoined()) SyncWorker.schedule(this)
        if (StudyWithdrawal.hasPending(this)) WithdrawalWorker.enqueue(this)
        setContentView(buildUi())
        if (savedInstanceState == null) {
            val occurrenceId = intent?.getStringExtra(NotificationHelper.EXTRA_OCCURRENCE_ID)
            val reason = when {
                occurrenceId != null -> "notification"
                intent?.data != null -> "deep_link"
                else -> "user"
            }
            background(null) { Telemetry.recordAppLaunch(this, reason) }
            handleIncomingUrl(intent?.data)
            occurrenceId?.let(::openPromptFromNotification)
        }
        refreshStatus()
        renderOpenPrompts()
        requestNotificationPermissionIfNeeded()
    }

    override fun onResume() {
        super.onResume()
        // Returning from Settings is when permissions change; snapshot so permission_changed is logged.
        background(null) { Telemetry.recordDeviceState(this, "app_foreground") }
        refreshStatus()
        renderOpenPrompts()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingUrl(intent.data)
        intent.getStringExtra(NotificationHelper.EXTRA_OCCURRENCE_ID)?.let(::openPromptFromNotification)
        refreshStatus()
    }

    private fun buildUi(): View {
        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(36, 36, 36, 48)
        }
        scroll.addView(root)

        root.addView(title("StudyTrace Android"))
        root.addView(body("Android client for StudyTrace research collection. It uploads GPS location, app usage, survey responses, device state, and client telemetry to the same StudyTrace server used by the iPhone app."))

        studyUrlEdit = EditText(this).apply {
            hint = "https://server/index.php/webservice/index/study/password"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(false)
            minLines = 2
            setText(prefs.studyUrl)
        }
        root.addView(label("Study URL"))
        root.addView(studyUrlEdit)

        consentCheck = CheckBox(this).apply {
            text = "Participant consent is granted for this device"
            isChecked = prefs.consentGranted
        }
        root.addView(consentCheck)

        root.addView(rowButton("Join / Refresh Study") { joinStudy() })
        root.addView(rowButton("Request Location Permission") { requestLocationPermission() })
        root.addView(rowButton("Open App Usage Permission") { startActivity(UsageStatsCollector.usageAccessIntent()) })
        root.addView(rowButton("Start Location Collection") { startLocationCollection() })
        root.addView(rowButton("Stop Location Collection") { stopLocationCollection() })
        root.addView(rowButton("Upload Now") { uploadNow() })
        root.addView(rowButton(getString(R.string.button_refresh_surveys)) { refreshSurveys() })
        root.addView(rowButton(getString(R.string.button_leave_study)) { confirmLeaveStudy() })

        statusText = body("")
        root.addView(label("Status"))
        root.addView(statusText)

        surveyList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(label("Surveys"))
        root.addView(surveyList)

        return scroll
    }

    private fun joinStudy() {
        val normalized = normalizeStudyUrl(studyUrlEdit.text.toString())
        if (normalized == null || parseStudyContext(normalized) == null) {
            toast("Enter a secure StudyTrace/AWARE HTTPS study URL.")
            return
        }
        val previousUrl = prefs.studyUrl
        prefs.studyUrl = normalized
        prefs.consentGranted = consentCheck.isChecked
        if (!prefs.consentGranted) {
            toast("Consent must be checked before collection starts.")
            refreshStatus()
            return
        }
        if (normalized != previousUrl || prefs.joinedAtMillis <= 0L) {
            prefs.joinedAtMillis = System.currentTimeMillis()
        }
        SyncWorker.schedule(this)
        background("Joining study...") {
            val api = StudyApi(this)
            val joined = api.joinStudy()
            Telemetry.recordEvent(this, if (joined) "android_study_joined" else "android_study_join_failed")
            Telemetry.recordDeviceState(this, "study_join")
            if (joined) {
                SurveyRepository.refreshConfig(this)
                SurveyRepository.runScheduler(this)
            }
            UploadQueue.drain(this, api)
            joined
        }.onResult { joined ->
            toast(if (joined) "Study joined." else "Study join failed. Check URL and credentials.")
            refreshStatus()
            renderOpenPrompts()
        }
    }

    private fun requestLocationPermission() {
        // Android 11+ ignores background location when it is requested together
        // with foreground location, so it is asked for as a separate second step.
        if (hasAnyLocationPermission() && Build.VERSION.SDK_INT >= 29 &&
            checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQUEST_LOCATION)
            return
        }
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT == 29) permissions += Manifest.permission.ACCESS_BACKGROUND_LOCATION
        requestPermissions(permissions.toTypedArray(), REQUEST_LOCATION)
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
    }

    private fun startLocationCollection() {
        if (!prefs.consentGranted) {
            toast("Join the study and grant consent first.")
            return
        }
        if (!hasAnyLocationPermission()) {
            requestLocationPermission()
            return
        }
        prefs.locationTrackingEnabled = true
        ContextCompat.startForegroundService(this, Intent(this, LocationTrackingService::class.java))
        toast("Location collection started.")
        refreshStatus()
    }

    private fun stopLocationCollection() {
        prefs.locationTrackingEnabled = false
        stopService(Intent(this, LocationTrackingService::class.java))
        background("Recording stop event...") {
            Telemetry.recordEvent(this, "android_location_collection_stopped")
        }
        refreshStatus()
    }

    private fun uploadNow() {
        if (!isJoined()) {
            toast("Join a study before upload.")
            return
        }
        background("Uploading...") {
            Telemetry.recordEvent(this, "android_manual_upload")
            Telemetry.recordDeviceState(this, "manual_upload")
            UsageStatsCollector.collectPending(this)
            SurveyRepository.refreshConfig(this)
            SurveyRepository.runScheduler(this)
            UploadQueue.drain(this) == UploadQueue.DrainResult.COMPLETE
        }.onResult { ok ->
            toast(getString(if (ok) R.string.upload_complete else R.string.upload_pending))
            refreshStatus()
            renderOpenPrompts()
        }
    }

    private fun refreshSurveys() {
        if (!isJoined()) {
            renderPrompts(emptyList())
            return
        }
        background("Fetching surveys...") {
            SurveyRepository.refreshConfig(this)
            SurveyRepository.runScheduler(this)
            SurveyRepository.openPrompts(this)
        }.onResult(::renderPrompts)
    }

    private fun renderOpenPrompts() {
        if (!::surveyList.isInitialized) return
        renderPrompts(if (isJoined()) SurveyRepository.openPrompts(this) else emptyList())
    }

    private fun renderPrompts(prompts: List<SurveyRepository.OpenPrompt>) {
        surveyList.removeAllViews()
        if (prompts.isEmpty()) {
            surveyList.addView(body(getString(R.string.surveys_none_open)))
            return
        }
        val timeFormat = DateFormat.getTimeInstance(DateFormat.SHORT)
        prompts.forEach { prompt ->
            val until = timeFormat.format(Date(prompt.record.expiresAtMillis))
            surveyList.addView(rowButton(getString(R.string.surveys_open_until, prompt.title, until)) {
                showSurvey(prompt)
            })
        }
    }

    private fun openPromptFromNotification(occurrenceId: String) {
        background(null) {
            SurveyRepository.recordTapped(this, occurrenceId)
            SurveyRepository.openPrompt(this, occurrenceId)
        }.onResult { prompt ->
            if (prompt != null) showSurvey(prompt) else toast(getString(R.string.survey_no_longer_available))
            renderOpenPrompts()
        }
    }

    private fun showSurvey(prompt: SurveyRepository.OpenPrompt) {
        val schedule = prompt.schedule
        val questions = SurveyRepository.allQuestions(schedule)
        if (questions.isEmpty()) {
            toast(getString(R.string.survey_no_questions))
            return
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 8, 24, 8)
        }
        val answerViews = mutableListOf<Pair<JSONObject, View>>()

        questions.forEach { question ->
            container.addView(label(question.optString("esm_title", "Question")))
            val instructions = question.optString("esm_instructions")
            if (instructions.isNotBlank()) container.addView(body(instructions))
            val radios = question.optJSONArray("esm_radios")
            if (radios != null && radios.length() > 0) {
                val group = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
                for (i in 0 until radios.length()) {
                    group.addView(RadioButton(this).apply { text = radios.optString(i) })
                }
                container.addView(group)
                answerViews += question to group
            } else {
                val edit = EditText(this).apply {
                    minLines = 2
                    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                }
                container.addView(edit)
                answerViews += question to edit
            }
            container.addView(Space(this).apply { minimumHeight = 18 })
        }

        AlertDialog.Builder(this)
            .setTitle(schedule.optString("notification_title", "StudyTrace survey"))
            .setView(ScrollView(this).apply { addView(container) })
            // "Later" keeps the prompt open until it expires; "Dismiss" records esm_status 1.
            .setNeutralButton(getString(R.string.survey_later), null)
            .setNegativeButton(getString(R.string.survey_dismiss)) { _, _ -> dismissSurvey(prompt) }
            .setPositiveButton(getString(R.string.survey_submit)) { _, _ ->
                val answers = answerViews.map { (question, view) ->
                    question to answerFromView(view)
                }
                submitSurvey(prompt, answers)
            }
            .show()
    }

    private fun submitSurvey(prompt: SurveyRepository.OpenPrompt, answers: List<Pair<JSONObject, String>>) {
        background("Submitting survey...") {
            if (SurveyRepository.submitAnswers(this, prompt.record.id, answers)) {
                UploadQueue.drain(this) == UploadQueue.DrainResult.COMPLETE
            } else {
                null
            }
        }.onResult { uploaded ->
            val message = when (uploaded) {
                null -> R.string.survey_already_closed
                true -> R.string.survey_submitted
                false -> R.string.survey_saved_offline
            }
            toast(getString(message))
            refreshStatus()
            renderOpenPrompts()
        }
    }

    private fun dismissSurvey(prompt: SurveyRepository.OpenPrompt) {
        background(null) {
            SurveyRepository.dismiss(this, prompt.record.id)
        }.onResult { dismissed ->
            if (dismissed) toast(getString(R.string.survey_dismissed))
            renderOpenPrompts()
        }
    }

    private fun confirmLeaveStudy() {
        if (!isJoined() && !prefs.consentGranted) {
            toast(getString(R.string.leave_study_not_joined))
            return
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.leave_study_title))
            .setMessage(getString(R.string.leave_study_message))
            .setPositiveButton(getString(R.string.leave_study_delete)) { _, _ -> leaveStudy(deleteUploadedData = true) }
            .setNeutralButton(getString(R.string.leave_study_keep)) { _, _ -> leaveStudy(deleteUploadedData = false) }
            .setNegativeButton(getString(R.string.leave_study_cancel), null)
            .show()
    }

    private fun leaveStudy(deleteUploadedData: Boolean) {
        val requestStored = StudyWithdrawal.leave(this, deleteUploadedData)
        studyUrlEdit.setText("")
        consentCheck.isChecked = false
        refreshStatus()
        renderPrompts(emptyList())
        if (!requestStored) {
            toast(getString(R.string.leave_study_done_local))
            return
        }
        background(null) {
            StudyWithdrawal.sendPending(this)
        }.onResult { result ->
            val message = when (result) {
                StudyWithdrawal.SendResult.SENT -> R.string.leave_study_done_sent
                StudyWithdrawal.SendResult.PENDING -> R.string.leave_study_done_pending
                StudyWithdrawal.SendResult.NONE -> R.string.leave_study_done_rejected
            }
            toast(getString(message))
            refreshStatus()
        }
    }

    private fun refreshStatus() {
        val context = parseStudyContext(prefs.studyUrl)
        val lastSync = if (prefs.lastSyncMillis > 0) {
            DateFormat.getDateTimeInstance().format(Date(prefs.lastSyncMillis))
        } else {
            "Never"
        }
        statusText.text = listOf(
            "Study: ${context?.studyId ?: "Not joined"}",
            "Device ID: ${prefs.deviceId}",
            "Consent: ${if (prefs.consentGranted) "granted" else "not granted"}",
            "Location: ${if (hasAnyLocationPermission()) "permission granted" else "permission missing"}",
            "App usage: ${if (UsageStatsCollector.hasUsageAccess(this)) "permission granted" else "permission missing"}",
            "Foreground location: ${if (prefs.locationTrackingEnabled) "enabled" else "stopped"}",
            "Last sync: $lastSync",
            getString(R.string.status_pending_uploads, UploadQueue.pendingCount(this)),
            if (StudyWithdrawal.hasPending(this)) getString(R.string.status_withdrawal_pending) else null,
        ).filterNotNull().joinToString("\n")
    }

    /**
     * A deep link only pre-fills the URL field. It is not saved until the
     * participant taps Join, so a link cannot silently redirect an enrolled
     * phone's uploads to another server.
     */
    private fun handleIncomingUrl(uri: Uri?) {
        if (uri == null) return
        val normalized = normalizeStudyUrl(uri.toString()) ?: return
        if (parseStudyContext(normalized) == null) return
        if (::studyUrlEdit.isInitialized) studyUrlEdit.setText(normalized)
    }

    private fun isJoined(): Boolean = prefs.consentGranted && parseStudyContext(prefs.studyUrl) != null

    private fun answerFromView(view: View): String =
        when (view) {
            is EditText -> view.text.toString()
            is RadioGroup -> {
                val selected = view.findViewById<RadioButton>(view.checkedRadioButtonId)
                selected?.text?.toString() ?: ""
            }
            else -> ""
        }

    private fun hasAnyLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun title(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 28f
            setTextColor(0xFF0F172A.toInt())
            setPadding(0, 0, 0, 14)
        }

    private fun label(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 16f
            setTextColor(0xFF334155.toInt())
            setPadding(0, 24, 0, 8)
        }

    private fun body(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextColor(0xFF475569.toInt())
            setLineSpacing(2f, 1.05f)
            setPadding(0, 0, 0, 10)
        }

    private fun rowButton(text: String, action: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            setAllCaps(false)
            setOnClickListener { action() }
        }

    private fun toast(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    }

    private fun <T> background(message: String?, block: () -> T): PendingResult<T> {
        if (message != null) toast(message)
        val result = PendingResult<T>()
        Thread {
            val value = runCatching(block)
            handler.post {
                value.onSuccess { result.deliver(it) }
                    .onFailure {
                        toast(it.localizedMessage ?: "Operation failed.")
                        result.deliverFailure()
                    }
            }
        }.start()
        return result
    }

    inner class PendingResult<T> {
        private var callback: ((T) -> Unit)? = null
        private var value: T? = null
        private var hasValue = false

        fun onResult(callback: (T) -> Unit) {
            this.callback = callback
            if (hasValue) {
                @Suppress("UNCHECKED_CAST")
                val current = value as T
                callback(current)
            }
        }

        // Tracks delivery separately from the value so null results still reach the callback.
        fun deliver(value: T) {
            this.value = value
            hasValue = true
            callback?.invoke(value)
        }

        fun deliverFailure() {
            refreshStatus()
        }
    }

    companion object {
        private const val REQUEST_LOCATION = 3001
        private const val REQUEST_NOTIFICATIONS = 3002
    }
}
