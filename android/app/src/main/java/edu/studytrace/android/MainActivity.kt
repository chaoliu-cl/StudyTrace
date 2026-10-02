package edu.studytrace.android

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.res.ColorStateList
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import android.widget.Toast
import android.app.Activity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

class MainActivity : Activity() {
    private lateinit var prefs: StudyPrefs
    private lateinit var studyUrlEdit: EditText
    private lateinit var consentCheck: CheckBox
    private lateinit var statusText: TextView
    private lateinit var surveyList: LinearLayout
    private lateinit var enrollmentStatus: TextView
    private lateinit var locationStatus: TextView
    private lateinit var usageStatus: TextView
    private lateinit var notificationStatus: TextView
    private lateinit var collectionStatus: TextView
    private lateinit var syncMetric: TextView
    private lateinit var uploadMetric: TextView
    private lateinit var dashboardStudy: TextView
    private lateinit var dashboardMobility: TextView
    private lateinit var dashboardPrivacy: TextView
    private lateinit var surveyIntro: TextView
    private lateinit var tabPages: Map<MainTab, View>
    private lateinit var tabLabels: Map<MainTab, TextView>
    private var selectedTab = MainTab.SURVEY
    private var showingOnboarding = false
    private var onboardingIndex = 0
    private var initialIntentHandled = false
    private val handler = Handler(Looper.getMainLooper())

    private enum class MainTab { SURVEY, DASHBOARD, SETTINGS }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = StudyPrefs(this)
        NotificationHelper.ensureChannels(this)
        if (isJoined()) SyncWorker.schedule(this)
        if (StudyWithdrawal.hasPending(this)) WithdrawalWorker.enqueue(this)

        // Existing enrolled participants already completed the older consent flow.
        // Migrate them without interrupting an active study after an app update.
        if (!prefs.onboardingDecisionRecorded && prefs.consentGranted && prefs.enrollmentConfirmed) {
            prefs.onboardingDecisionRecorded = true
            prefs.onboardingConsentGranted = true
        }

        if (savedInstanceState == null && prefs.onboardingConsentGranted) {
            val occurrenceId = intent?.getStringExtra(NotificationHelper.EXTRA_OCCURRENCE_ID)
            val reason = when {
                occurrenceId != null -> "notification"
                intent?.data != null -> "deep_link"
                else -> "user"
            }
            background(null) { Telemetry.recordAppLaunch(this, reason) }
        }

        if (!prefs.onboardingDecisionRecorded) {
            showOnboarding()
        } else {
            showMainContent()
        }
    }

    override fun onResume() {
        super.onResume()
        if (showingOnboarding || !::studyUrlEdit.isInitialized) return
        // Returning from Settings is when permissions change; snapshot so permission_changed is logged.
        if (prefs.onboardingConsentGranted) {
            background(null) { Telemetry.recordDeviceState(this, "app_foreground") }
        }
        refreshStatus()
        renderOpenPrompts()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (showingOnboarding) return
        handleIncomingUrl(intent.data)
        intent.getStringExtra(NotificationHelper.EXTRA_OCCURRENCE_ID)?.let(::openPromptFromNotification)
        refreshStatus()
    }

    private fun showMainContent() {
        showingOnboarding = false
        setContentView(buildUi())
        if (!initialIntentHandled) {
            handleIncomingUrl(intent?.data)
            intent?.getStringExtra(NotificationHelper.EXTRA_OCCURRENCE_ID)?.let(::openPromptFromNotification)
            initialIntentHandled = true
        }
        refreshStatus()
        renderOpenPrompts()
    }

    private enum class OnboardingAction {
        NEXT,
        CONSENT,
        LOCATION,
        USAGE,
        NOTIFICATIONS,
        FINISH,
    }

    private data class OnboardingPage(
        val symbol: String,
        val title: String,
        val body: String,
        val buttonTitle: String,
        val action: OnboardingAction,
    )

    private fun onboardingPages(): List<OnboardingPage> = listOf(
        OnboardingPage(
            "ST",
            getString(R.string.onboarding_about_title),
            getString(R.string.onboarding_about_body),
            "Next",
            OnboardingAction.NEXT,
        ),
        OnboardingPage(
            "▥",
            getString(R.string.onboarding_data_title),
            getString(R.string.onboarding_data_body),
            "Next",
            OnboardingAction.NEXT,
        ),
        OnboardingPage(
            "R",
            getString(R.string.onboarding_researchers_title),
            getString(R.string.onboarding_researchers_body),
            "Next",
            OnboardingAction.NEXT,
        ),
        OnboardingPage(
            "✓",
            getString(R.string.onboarding_consent_title),
            getString(R.string.onboarding_consent_body),
            getString(R.string.onboarding_consent_agree),
            OnboardingAction.CONSENT,
        ),
        OnboardingPage(
            "⌖",
            getString(R.string.onboarding_location_title),
            getString(R.string.onboarding_location_body),
            "Allow",
            OnboardingAction.LOCATION,
        ),
        OnboardingPage(
            "▤",
            getString(R.string.onboarding_usage_title),
            getString(R.string.onboarding_usage_body),
            "Open Settings",
            OnboardingAction.USAGE,
        ),
        OnboardingPage(
            "!",
            getString(R.string.onboarding_notifications_title),
            getString(R.string.onboarding_notifications_body),
            "Allow",
            OnboardingAction.NOTIFICATIONS,
        ),
        OnboardingPage(
            "✓",
            getString(R.string.onboarding_welcome_title),
            getString(R.string.onboarding_welcome_body),
            getString(R.string.onboarding_get_started),
            OnboardingAction.FINISH,
        ),
    )

    private fun showOnboarding(startIndex: Int = 0) {
        showingOnboarding = true
        val pages = onboardingPages()
        onboardingIndex = startIndex.coerceIn(0, pages.lastIndex)
        setContentView(buildOnboardingUi(pages[onboardingIndex], pages.size))
    }

    private fun buildOnboardingUi(page: OnboardingPage, pageCount: Int): View {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(SURFACE)
            setPadding(dp(20), dp(14), dp(20), dp(22))
        }
        ViewCompat.setOnApplyWindowInsetsListener(outer) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(
                dp(20) + bars.left,
                dp(14) + bars.top,
                dp(20) + bars.right,
                dp(18) + bars.bottom,
            )
            insets
        }

        val top = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        top.addView(TextView(this).apply {
            text = "ST"
            textSize = 15f
            setTextColor(Color.WHITE)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(ACCENT, ACCENT_DARK),
            ).apply { cornerRadius = dp(13).toFloat() }
        }, LinearLayout.LayoutParams(dp(42), dp(42)))
        top.addView(TextView(this).apply {
            text = "StudyTrace"
            textSize = 18f
            setTextColor(INK)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(dp(11), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (page.action != OnboardingAction.CONSENT && page.action != OnboardingAction.FINISH) {
            top.addView(TextView(this).apply {
                text = "Skip"
                textSize = 14f
                setTextColor(MUTED)
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(dp(14), dp(10), dp(2), dp(10))
                setOnClickListener { advanceOnboarding() }
            })
        }
        outer.addView(top)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(14), dp(34), dp(14), dp(24))
        }
        content.addView(TextView(this).apply {
            text = page.symbol
            textSize = if (page.symbol.length > 1) 24f else 34f
            setTextColor(ACCENT)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = roundedBackground(0xFFEFF6FF.toInt(), dp(40), 0xFFBFDBFE.toInt(), 1)
        }, LinearLayout.LayoutParams(dp(80), dp(80)).apply { bottomMargin = dp(26) })
        content.addView(TextView(this).apply {
            text = page.title
            textSize = 27f
            setTextColor(INK)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(14))
        }, spacedParams(0))
        content.addView(TextView(this).apply {
            text = page.body
            textSize = 16f
            setTextColor(MUTED)
            gravity = Gravity.CENTER
            setLineSpacing(dp(3).toFloat(), 1.12f)
        }, spacedParams(0))

        outer.addView(ScrollView(this).apply {
            isFillViewport = true
            overScrollMode = View.OVER_SCROLL_NEVER
            addView(content)
        }, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f,
        ))

        outer.addView(TextView(this).apply {
            text = "${onboardingIndex + 1} of $pageCount"
            textSize = 12f
            setTextColor(MUTED)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(10))
        })
        outer.addView(primaryButton(page.buttonTitle) { handleOnboardingAction(page.action) })
        if (page.action == OnboardingAction.CONSENT) {
            outer.addView(TextView(this).apply {
                text = getString(R.string.onboarding_consent_decline)
                textSize = 14f
                setTextColor(DANGER)
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setPadding(dp(12), dp(16), dp(12), dp(8))
                setOnClickListener { confirmDeclineOnboarding() }
            })
        }
        return outer
    }

    private fun handleOnboardingAction(action: OnboardingAction) {
        when (action) {
            OnboardingAction.NEXT -> advanceOnboarding()
            OnboardingAction.CONSENT -> {
                prefs.onboardingDecisionRecorded = true
                prefs.onboardingConsentGranted = true
                advanceOnboarding()
            }
            OnboardingAction.LOCATION -> {
                advanceOnboarding()
                // Keep the full Google Play prominent disclosure immediately before
                // Android's system permission prompt.
                requestLocationPermission()
            }
            OnboardingAction.USAGE -> {
                advanceOnboarding()
                requestUsageAccess()
            }
            OnboardingAction.NOTIFICATIONS -> {
                advanceOnboarding()
                requestNotificationPermission()
            }
            OnboardingAction.FINISH -> showMainContent()
        }
    }

    private fun advanceOnboarding() {
        val lastIndex = onboardingPages().lastIndex
        if (onboardingIndex >= lastIndex) {
            showMainContent()
        } else {
            showOnboarding(onboardingIndex + 1)
        }
    }

    private fun confirmDeclineOnboarding() {
        val dialog = AlertDialog.Builder(this)
            .setTitle(getString(R.string.onboarding_decline_title))
            .setMessage(getString(R.string.onboarding_decline_body))
            .setNegativeButton("Go Back", null)
            .setPositiveButton(getString(R.string.onboarding_consent_decline)) { _, _ ->
                prefs.onboardingDecisionRecorded = true
                prefs.onboardingConsentGranted = false
                if (isJoined() || prefs.consentGranted) {
                    StudyWithdrawal.leave(this, deleteUploadedData = false)
                } else {
                    prefs.consentGranted = false
                    prefs.locationTrackingEnabled = false
                    stopService(Intent(this, LocationTrackingService::class.java))
                }
                showMainContent()
            }
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(DANGER)
        }
        dialog.show()
    }

    private fun buildUi(): View {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(SURFACE)
        }
        ViewCompat.setOnApplyWindowInsetsListener(outer) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val pages = FrameLayout(this)
        val surveysRoot = tabRoot()
        val dashboardRoot = tabRoot()
        val settingsRoot = tabRoot()
        val tabs = mapOf(
            MainTab.SURVEY to tabScroll(surveysRoot),
            MainTab.DASHBOARD to tabScroll(dashboardRoot),
            MainTab.SETTINGS to tabScroll(settingsRoot),
        )
        tabPages = tabs
        tabs.values.forEach { pages.addView(it) }
        outer.addView(pages, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f,
        ))

        val nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(12), dp(9), dp(12), dp(7))
            setBackgroundColor(Color.WHITE)
            elevation = dp(8).toFloat()
        }
        val labels = mutableMapOf<MainTab, TextView>()
        listOf(
            Triple(MainTab.SURVEY, "▤", "Survey"),
            Triple(MainTab.DASHBOARD, "▥", "Dashboard"),
            Triple(MainTab.SETTINGS, "⚙", "Settings"),
        ).forEach { (tab, symbol, title) ->
            val item = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                minimumHeight = dp(55)
                contentDescription = title
                isClickable = true
                isFocusable = true
                setOnClickListener { selectTab(tab) }
            }
            item.addView(TextView(this).apply {
                text = symbol
                textSize = 21f
                gravity = Gravity.CENTER
                setTextColor(MUTED)
            })
            val label = TextView(this).apply {
                text = title
                textSize = 11f
                typeface = Typeface.DEFAULT_BOLD
                gravity = Gravity.CENTER
                setTextColor(MUTED)
            }
            labels[tab] = label
            item.addView(label)
            nav.addView(item, LinearLayout.LayoutParams(0, dp(58), 1f))
        }
        tabLabels = labels
        outer.addView(nav)

        dashboardRoot.addView(pageHeader("Dashboard", "Your study at a glance"), spacedParams(dp(18)))
        settingsRoot.addView(pageHeader("Settings", "Study participation and privacy controls"), spacedParams(dp(18)))
        surveysRoot.addView(pageHeader("Survey", "Questions from your research team"), spacedParams(dp(18)))

        settingsRoot.addView(card().apply {
            addView(eyebrow("CONSENT & ONBOARDING", ACCENT))
            addView(sectionTitle("Review your choices"))
            addView(mutedBody("You can revisit the upfront information and consent screens at any time."))
            addView(outlineButton(getString(R.string.onboarding_review)) { showOnboarding() })
        }, spacedParams(dp(16)))

        val root = dashboardRoot

        val brandRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        brandRow.addView(TextView(this).apply {
            text = "ST"
            textSize = 20f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            typeface = Typeface.DEFAULT_BOLD
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(ACCENT, ACCENT_DARK),
            ).apply { cornerRadius = dp(18).toFloat() }
        }, LinearLayout.LayoutParams(dp(58), dp(58)))
        brandRow.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), 0, 0, 0)
            addView(TextView(this@MainActivity).apply {
                text = "StudyTrace"
                textSize = 24f
                setTextColor(INK)
                typeface = Typeface.DEFAULT_BOLD
            })
            addView(TextView(this@MainActivity).apply {
                text = "Research participation, made clear"
                textSize = 13f
                setTextColor(MUTED)
            })
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        brandRow.addView(TextView(this).apply {
            text = "Privacy"
            textSize = 14f
            setTextColor(ACCENT)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(10), dp(4), dp(10))
            setOnClickListener { openPrivacyPolicy() }
        })
        root.addView(brandRow, spacedParams(dp(28)))

        val hero = card().apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                intArrayOf(0xFF1D4ED8.toInt(), 0xFF4338CA.toInt()),
            ).apply { cornerRadius = dp(24).toFloat() }
            addView(eyebrow("STUDY OVERVIEW", 0xFFDBEAFE.toInt()))
            addView(TextView(this@MainActivity).apply {
                text = "Your contribution,\nyour control."
                textSize = 28f
                setTextColor(Color.WHITE)
                typeface = Typeface.DEFAULT_BOLD
                setLineSpacing(0f, 1.04f)
                setPadding(0, dp(8), 0, dp(10))
            })
            addView(TextView(this@MainActivity).apply {
                text = "See your participation, collection status, and data delivery in one place."
                textSize = 15f
                setTextColor(0xFFE0E7FF.toInt())
                setLineSpacing(dp(2).toFloat(), 1.08f)
            })
        }
        root.addView(hero, spacedParams(dp(16)))

        root.addView(card().apply {
            addView(eyebrow("STUDY PARTICIPATION", ACCENT))
            addView(sectionTitle("Study Participation"))
            dashboardStudy = mutedBody("")
            addView(dashboardStudy)
            addView(outlineButton("Manage study") { selectTab(MainTab.SETTINGS) })
        }, spacedParams(dp(16)))

        root.addView(card().apply {
            addView(eyebrow("MOBILITY SUMMARY", ACCENT))
            addView(sectionTitle("Mobility Summary"))
            dashboardMobility = mutedBody("")
            addView(dashboardMobility)
            addView(outlineButton("Collection settings") { selectTab(MainTab.SETTINGS) })
        }, spacedParams(dp(16)))

        root.addView(card().apply {
            addView(eyebrow("PRIVATE & SECURE", ACCENT))
            addView(sectionTitle("Your data, your choice"))
            dashboardPrivacy = mutedBody("")
            addView(dashboardPrivacy)
            addView(outlineButton("Privacy and consent") { selectTab(MainTab.SETTINGS) })
        }, spacedParams(dp(16)))

        val enrollmentCard = card().apply {
            val heading = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            heading.addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(eyebrow("STEP 1", ACCENT))
                addView(sectionTitle("Join your study"))
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            enrollmentStatus = statusBadge("Not joined", false)
            heading.addView(enrollmentStatus)
            addView(heading)
            addView(mutedBody("Paste the secure invitation link supplied by your research team."))
        }

        studyUrlEdit = EditText(this).apply {
            hint = "https://server/index.php/webservice/index/study/password"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(false)
            minLines = 2
            maxLines = 3
            setText(prefs.studyUrl)
            textSize = 14f
            setTextColor(INK)
            setHintTextColor(0xFF94A3B8.toInt())
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = roundedBackground(INPUT, dp(14), BORDER, 1)
        }
        enrollmentCard.addView(fieldLabel("Study invitation link"))
        enrollmentCard.addView(studyUrlEdit, spacedParams(dp(8)))
        enrollmentCard.addView(outlineButton(getString(R.string.scan_study_qr)) { scanStudyQrCode() }, spacedParams(dp(12)))

        consentCheck = CheckBox(this).apply {
            text = getString(R.string.consent_checkbox)
            isChecked = prefs.consentGranted
            textSize = 14f
            setTextColor(INK_SOFT)
            buttonTintList = ColorStateList(
                arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
                intArrayOf(ACCENT, 0xFF94A3B8.toInt()),
            )
            setPadding(0, dp(2), 0, dp(8))
        }
        enrollmentCard.addView(consentCheck)
        enrollmentCard.addView(primaryButton("Join or refresh study") { joinStudy() })
        settingsRoot.addView(enrollmentCard, spacedParams(dp(16)))

        val permissionCard = card().apply {
            addView(eyebrow("STEP 2", ACCENT))
            addView(sectionTitle("Review data permissions"))
            addView(mutedBody("StudyTrace only collects categories included in your study consent."))
            locationStatus = statusBadge("Not allowed", false)
            addView(actionRow(
                "Location",
                "Mobility and context sensing",
                locationStatus,
                "Review location access",
            ) { requestLocationPermission() })
            addView(divider())
            usageStatus = statusBadge("Not allowed", false)
            addView(actionRow(
                "App activity",
                "Usage duration and screen events — never content",
                usageStatus,
                "Open app activity access",
            ) { requestUsageAccess() })
            addView(divider())
            notificationStatus = statusBadge("Not allowed", false)
            addView(actionRow(
                "Study notifications",
                "Survey reminders and collection status",
                notificationStatus,
                "Enable notifications",
            ) { requestNotificationPermission() })
        }
        settingsRoot.addView(permissionCard, spacedParams(dp(16)))

        val collectionCard = card().apply {
            val heading = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            heading.addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(eyebrow("STEP 3", ACCENT))
                addView(sectionTitle("Collection controls"))
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            collectionStatus = statusBadge("Stopped", false)
            heading.addView(collectionStatus)
            addView(heading)
            addView(mutedBody("Start or stop background location collection without leaving your study."))
            val controls = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
            }
            controls.addView(primaryButton("Start collection") { startLocationCollection() }, weightedButtonParams(dp(8)))
            controls.addView(outlineButton("Stop") { stopLocationCollection() }, weightedButtonParams(0))
            addView(controls)
        }
        settingsRoot.addView(collectionCard, spacedParams(dp(16)))

        val activityCard = card().apply {
            addView(eyebrow("STUDY ACTIVITY", ACCENT))
            addView(sectionTitle("Stay up to date"))
            val metrics = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            syncMetric = metricValue("Never", "Last sync")
            uploadMetric = metricValue("0", "Queued")
            metrics.addView(syncMetric, weightedButtonParams(dp(8)))
            metrics.addView(uploadMetric, weightedButtonParams(0))
            addView(metrics, spacedParams(dp(14)))

            val activityActions = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
            }
            activityActions.addView(primaryButton("Upload now") { uploadNow() }, weightedButtonParams(dp(8)))
            activityActions.addView(outlineButton("Refresh surveys") { refreshSurveys() }, weightedButtonParams(0))
            addView(activityActions)
        }
        root.addView(activityCard, spacedParams(dp(16)))

        surveysRoot.addView(card().apply {
            addView(eyebrow("AVAILABLE NOW", ACCENT))
            addView(sectionTitle("Open surveys"))
            surveyIntro = mutedBody("")
            addView(surveyIntro)
            surveyList = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(surveyList)
            addView(outlineButton("Refresh surveys") { refreshSurveys() }, spacedParams(0).apply {
                topMargin = dp(12)
            })
        }, spacedParams(dp(16)))
        surveysRoot.addView(card().apply {
            addView(sectionTitle("How surveys work"))
            addView(mutedBody("When your study sends a survey, it appears here until its response window closes. You can also open it from a notification."))
            addView(outlineButton("Study settings") { selectTab(MainTab.SETTINGS) })
        }, spacedParams(dp(16)))

        val detailsCard = card().apply {
            addView(sectionTitle("Device & study details"))
            statusText = mutedBody("")
            addView(statusText)
            addView(outlineButton("Privacy policy") { openPrivacyPolicy() }, spacedParams(dp(10)))
            addView(dangerButton(getString(R.string.button_leave_study)) { confirmLeaveStudy() })
        }
        settingsRoot.addView(detailsCard, spacedParams(dp(18)))

        settingsRoot.addView(TextView(this).apply {
            text = "StudyTrace stores study data on this device first and encrypts it in transit to the research server configured by your study."
            textSize = 12f
            setTextColor(MUTED)
            gravity = Gravity.CENTER
            setLineSpacing(0f, 1.15f)
            setPadding(dp(12), 0, dp(12), 0)
        })

        selectTab(selectedTab)
        return outer
    }

    private fun joinStudy() {
        if (!prefs.onboardingConsentGranted) {
            toast(getString(R.string.onboarding_required))
            showOnboarding(CONSENT_PAGE_INDEX)
            return
        }
        val normalized = normalizeStudyUrl(studyUrlEdit.text.toString())
        val candidate = normalized?.let(::parseStudyContext)
        if (normalized == null || candidate == null) {
            toast("Enter a secure StudyTrace/AWARE HTTPS study URL.")
            return
        }
        if (!consentCheck.isChecked) {
            toast("Consent must be checked before collection starts.")
            refreshStatus()
            return
        }
        val previousUrl = prefs.studyUrl
        val previousConfirmed = prefs.enrollmentConfirmed
        background("Joining study...") {
            val api = StudyApi(this)
            val joined = api.joinStudy(candidate)
            if (joined) {
                if (normalized != previousUrl || !previousConfirmed) {
                    // Stop old collectors before waiting for a drain and deleting old-study state.
                    prefs.consentGranted = false
                    prefs.enrollmentConfirmed = false
                    prefs.locationTrackingEnabled = false
                    stopService(Intent(this, LocationTrackingService::class.java))
                    SyncWorker.cancel(this)
                    UploadQueue.purge(this)
                    SurveyRepository.clear(this)
                    NotificationHelper.cancelAll(this)
                    prefs.clearStudy()
                    prefs.studyUrl = normalized
                    prefs.joinedAtMillis = System.currentTimeMillis()
                }
                prefs.consentGranted = true
                prefs.enrollmentConfirmed = true
                SyncWorker.schedule(this)
                Telemetry.recordEvent(this, "android_study_joined")
                Telemetry.recordDeviceState(this, "study_join")
                SurveyRepository.refreshConfig(this)
                SurveyRepository.runScheduler(this)
                UploadQueue.drain(this, api)
            }
            joined
        }.onResult { joined ->
            toast(if (joined) "Study joined." else "Study join failed. Check URL and credentials.")
            if (!joined && previousConfirmed) studyUrlEdit.setText(previousUrl)
            refreshStatus()
            renderOpenPrompts()
        }
    }

    private fun scanStudyQrCode() {
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(this, options).startScan()
            .addOnSuccessListener { barcode ->
                val normalized = barcode.rawValue?.let(::normalizeScannedStudyUrl)
                val context = normalized?.let(::parseStudyContext)
                if (normalized == null || context == null) {
                    toast(getString(R.string.scan_invalid_qr))
                    return@addOnSuccessListener
                }
                AlertDialog.Builder(this)
                    .setTitle(getString(R.string.scan_found_title))
                    .setMessage(getString(
                        R.string.scan_found_message,
                        Uri.parse(normalized).host ?: "",
                        context.studyId,
                    ))
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(getString(R.string.scan_use_link)) { _, _ ->
                        studyUrlEdit.setText(normalized)
                        selectTab(MainTab.SETTINGS)
                    }
                    .show()
            }
            .addOnFailureListener { toast(getString(R.string.scan_unavailable)) }
    }

    private fun requestLocationPermission() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.location_disclosure_title))
            .setMessage(getString(R.string.location_disclosure_message))
            .setPositiveButton(getString(R.string.continue_label)) { _, _ -> requestLocationPermissionAfterDisclosure() }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun requestLocationPermissionAfterDisclosure() {
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

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        } else {
            toast(getString(R.string.notifications_already_enabled))
        }
    }

    private fun requestUsageAccess() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.usage_disclosure_title))
            .setMessage(getString(R.string.usage_disclosure_message))
            .setPositiveButton(getString(R.string.continue_label)) { _, _ ->
                startActivity(UsageStatsCollector.usageAccessIntent())
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun openPrivacyPolicy() {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_POLICY_URL)))
    }

    private fun startLocationCollection() {
        if (!isJoined()) {
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
        selectTab(MainTab.SURVEY)
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
        if (::surveyIntro.isInitialized) {
            surveyIntro.text = when {
                !isJoined() -> "Join your study in Settings to receive surveys."
                prompts.isEmpty() -> "You are all caught up. New surveys from your study will appear here."
                prompts.size == 1 -> "You have 1 survey ready to answer."
                else -> "You have ${prompts.size} surveys ready to answer."
            }
        }
        if (prompts.isEmpty()) {
            if (!isJoined()) {
                surveyList.addView(primaryButton("Join a study") { selectTab(MainTab.SETTINGS) })
            } else {
                surveyList.addView(body(getString(R.string.surveys_none_open)))
            }
            return
        }
        val timeFormat = DateFormat.getTimeInstance(DateFormat.SHORT)
        prompts.forEach { prompt ->
            val until = timeFormat.format(Date(prompt.record.expiresAtMillis))
            surveyList.addView(primaryButton(getString(R.string.surveys_open_until, prompt.title, until)) {
                showSurvey(prompt)
            }, spacedParams(dp(10)))
        }
    }

    private fun openPromptFromNotification(occurrenceId: String) {
        background(null) {
            SurveyRepository.recordTapped(this, occurrenceId)
            SurveyRepository.openPrompt(this, occurrenceId)
        }.onResult { prompt ->
            selectTab(MainTab.SURVEY)
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
        val context = if (prefs.enrollmentConfirmed) parseStudyContext(prefs.studyUrl) else null
        val lastSync = if (prefs.lastSyncMillis > 0) {
            DateFormat.getDateTimeInstance().format(Date(prefs.lastSyncMillis))
        } else {
            "Never"
        }
        val joined = context != null && prefs.consentGranted
        val hasLocation = hasAnyLocationPermission()
        val hasUsage = UsageStatsCollector.hasUsageAccess(this)
        val hasNotifications = Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val queued = UploadQueue.pendingCount(this)

        if (::enrollmentStatus.isInitialized) setBadge(enrollmentStatus, if (joined) "Joined" else "Not joined", joined)
        if (::locationStatus.isInitialized) setBadge(locationStatus, if (hasLocation) "Allowed" else "Not allowed", hasLocation)
        if (::usageStatus.isInitialized) setBadge(usageStatus, if (hasUsage) "Allowed" else "Not allowed", hasUsage)
        if (::notificationStatus.isInitialized) setBadge(notificationStatus, if (hasNotifications) "Enabled" else "Not allowed", hasNotifications)
        if (::collectionStatus.isInitialized) {
            setBadge(collectionStatus, if (prefs.locationTrackingEnabled) "Active" else "Stopped", prefs.locationTrackingEnabled)
        }
        if (::syncMetric.isInitialized) {
            val shortSync = if (prefs.lastSyncMillis > 0) {
                DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(prefs.lastSyncMillis))
            } else {
                "Never"
            }
            syncMetric.text = "$shortSync\nLast sync"
        }
        if (::uploadMetric.isInitialized) uploadMetric.text = "$queued\nQueued uploads"
        if (::dashboardStudy.isInitialized) {
            dashboardStudy.text = if (joined) {
                "Study ${context?.studyId} is active. Consent is granted, and your participation settings are available at any time."
            } else {
                "No study is joined yet. Open Settings to enter your invitation link and review consent."
            }
        }
        if (::dashboardMobility.isInitialized) {
            dashboardMobility.text = when {
                !joined -> "Location collection is off until you join a study and choose to start it."
                prefs.locationTrackingEnabled && hasLocation -> "Location collection is active. You can pause it at any time in Settings."
                hasLocation -> "Location access is allowed, but collection is currently stopped."
                else -> "Location access is not allowed, so collection is stopped."
            }
        }
        if (::dashboardPrivacy.isInitialized) {
            dashboardPrivacy.text = "${if (prefs.consentGranted) "Consent granted" else "Consent not granted"} · $queued queued upload${if (queued == 1) "" else "s"}. Data is stored on this device before secure delivery to your study server."
        }
        if (::statusText.isInitialized) {
            statusText.text = listOf(
                "Study  ${context?.studyId ?: "Not joined"}",
                "Consent  ${if (prefs.consentGranted) "Granted" else "Not granted"}",
                "Device  ${prefs.deviceId}",
                "Last sync  $lastSync",
                if (StudyWithdrawal.hasPending(this)) getString(R.string.status_withdrawal_pending) else null,
            ).filterNotNull().joinToString("\n\n")
        }
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
        if (::studyUrlEdit.isInitialized) {
            studyUrlEdit.setText(normalized)
            selectTab(MainTab.SETTINGS)
        }
    }

    private fun isJoined(): Boolean =
        prefs.consentGranted && prefs.enrollmentConfirmed && parseStudyContext(prefs.studyUrl) != null

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

    private fun tabRoot(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(20), dp(22), dp(20), dp(28))
    }

    private fun tabScroll(content: View): ScrollView = ScrollView(this).apply {
        isFillViewport = true
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(content)
    }

    private fun pageHeader(title: String, subtitle: String): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(TextView(this@MainActivity).apply {
            text = title
            textSize = 29f
            setTextColor(INK)
            typeface = Typeface.DEFAULT_BOLD
        })
        addView(TextView(this@MainActivity).apply {
            text = subtitle
            textSize = 14f
            setTextColor(MUTED)
            setPadding(0, dp(4), 0, 0)
        })
    }

    private fun selectTab(tab: MainTab) {
        if (!::tabPages.isInitialized || !::tabLabels.isInitialized) return
        selectedTab = tab
        tabPages.forEach { (page, view) -> view.visibility = if (page == tab) View.VISIBLE else View.GONE }
        tabLabels.forEach { (page, label) ->
            val active = page == tab
            label.setTextColor(if (active) ACCENT else MUTED)
            val item = label.parent as LinearLayout
            item.isSelected = active
            (item.getChildAt(0) as TextView).setTextColor(if (active) ACCENT else MUTED)
            item.background = if (active) roundedBackground(0xFFEFF6FF.toInt(), dp(16)) else null
        }
    }

    private fun card(): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(20))
            background = roundedBackground(Color.WHITE, dp(24), BORDER, 1)
            elevation = dp(2).toFloat()
        }

    private fun sectionTitle(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 21f
            setTextColor(INK)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(4), 0, dp(8))
        }

    private fun eyebrow(text: String, color: Int): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 11f
            setTextColor(color)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.08f
        }

    private fun mutedBody(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 14f
            setTextColor(MUTED)
            setLineSpacing(dp(1).toFloat(), 1.08f)
            setPadding(0, 0, 0, dp(14))
        }

    private fun fieldLabel(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 13f
            setTextColor(INK_SOFT)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, dp(8), 0, dp(7))
        }

    private fun statusBadge(text: String, positive: Boolean): TextView =
        TextView(this).apply {
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(11), dp(7), dp(11), dp(7))
            setBadge(this, text, positive)
        }

    private fun setBadge(view: TextView, text: String, positive: Boolean) {
        view.text = text
        view.setTextColor(if (positive) SUCCESS else MUTED)
        view.background = roundedBackground(
            if (positive) SUCCESS_SOFT else 0xFFF1F5F9.toInt(),
            dp(20),
            if (positive) 0xFFA7F3D0.toInt() else BORDER,
            1,
        )
    }

    private fun actionRow(
        title: String,
        description: String,
        status: TextView,
        buttonText: String,
        action: () -> Unit,
    ): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(0, dp(14), 0, dp(14))
        val heading = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        heading.addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 16f
                setTextColor(INK)
                typeface = Typeface.DEFAULT_BOLD
            })
            addView(TextView(this@MainActivity).apply {
                text = description
                textSize = 13f
                setTextColor(MUTED)
                setPadding(0, dp(3), dp(8), 0)
            })
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        heading.addView(status)
        addView(heading)
        addView(outlineButton(buttonText, action), spacedParams(0).apply { topMargin = dp(12) })
    }

    private fun divider(): View = View(this).apply { setBackgroundColor(BORDER) }.also {
        it.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1))
    }

    private fun metricValue(value: String, label: String): TextView =
        TextView(this).apply {
            text = "$value\n$label"
            textSize = 16f
            setTextColor(INK)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setLineSpacing(dp(2).toFloat(), 1f)
            setPadding(dp(10), dp(13), dp(10), dp(13))
            background = roundedBackground(INPUT, dp(14), BORDER, 1)
        }

    private fun primaryButton(text: String, action: () -> Unit): Button =
        button(text, Color.WHITE, ACCENT, action)

    private fun outlineButton(text: String, action: () -> Unit): Button =
        button(text, ACCENT, Color.WHITE, action, BORDER)

    private fun dangerButton(text: String, action: () -> Unit): Button =
        button(text, DANGER, DANGER_SOFT, action, 0xFFFECACA.toInt())

    private fun button(
        text: String,
        textColor: Int,
        fillColor: Int,
        action: () -> Unit,
        strokeColor: Int = fillColor,
    ): Button = Button(this).apply {
        this.text = text
        setAllCaps(false)
        textSize = 14f
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(textColor)
        gravity = Gravity.CENTER
        minimumHeight = dp(50)
        minHeight = dp(50)
        minWidth = 0
        stateListAnimator = null
        setPadding(dp(14), dp(11), dp(14), dp(11))
        backgroundTintList = null
        background = roundedBackground(fillColor, dp(14), strokeColor, 1)
        setOnClickListener { action() }
    }

    private fun spacedParams(bottomMargin: Int): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { this.bottomMargin = bottomMargin }

    private fun weightedButtonParams(endMargin: Int): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginEnd = endMargin
        }

    private fun roundedBackground(
        fillColor: Int,
        radius: Int,
        strokeColor: Int = fillColor,
        strokeWidth: Int = 0,
    ): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        setColor(fillColor)
        cornerRadius = radius.toFloat()
        if (strokeWidth > 0) setStroke(dp(strokeWidth), strokeColor)
    }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun label(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 16f
            setTextColor(INK_SOFT)
            typeface = Typeface.DEFAULT_BOLD
            setPadding(0, 24, 0, 8)
        }

    private fun body(text: String): TextView =
        TextView(this).apply {
            this.text = text
            textSize = 15f
            setTextColor(MUTED)
            setLineSpacing(2f, 1.05f)
            setPadding(0, 0, 0, 10)
        }

    private fun rowButton(text: String, action: () -> Unit): Button =
        outlineButton(text, action)

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
        private const val CONSENT_PAGE_INDEX = 3
        private const val PRIVACY_POLICY_URL = "https://liu-chao.site/StudyTrace/privacy/"

        private val ACCENT = 0xFF2563EB.toInt()
        private val ACCENT_DARK = 0xFF4338CA.toInt()
        private val SURFACE = 0xFFF4F6FC.toInt()
        private val INPUT = 0xFFF8FAFC.toInt()
        private val INK = 0xFF0F172A.toInt()
        private val INK_SOFT = 0xFF334155.toInt()
        private val MUTED = 0xFF64748B.toInt()
        private val BORDER = 0xFFE2E8F0.toInt()
        private val SUCCESS = 0xFF047857.toInt()
        private val SUCCESS_SOFT = 0xFFECFDF5.toInt()
        private val DANGER = 0xFFB91C1C.toInt()
        private val DANGER_SOFT = 0xFFFEF2F2.toInt()
    }
}
