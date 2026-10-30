# Mind-body pilot with surveys and app usage screenshots

> **Historical protocol and older dashboard instructions.** For the current pilot
> (each questionnaire once daily plus one evening screenshot), use the
> [complete deployment and dashboard configuration guide](../../RAILWAY_PILOT_DEPLOYMENT.md).
> The current **Survey and screenshot schedules** editor replaces the separate
> forms described below. Do not apply this older protocol to the current pilot.

This pilot asks participants to complete PANAS-10, PSS-10, and MWQ together at three random daily prompts, and to upload one fresh app usage screenshot at each of three separate random daily prompts. That is **six intended notifications per day: 75 questionnaire ratings and three screenshots**. A seven-day run requests 525 ratings and 21 screenshots per participant.

Use today's cumulative usage so far for each screenshot. On iPhone, use **Screen Time**; on Android, use **Digital Wellbeing** or the manufacturer's equivalent. These prompts do not capture the screen automatically. Participants take and select each image themselves.

## 1. Deploy the version that supports this pilot

The new researcher section is called **App usage screenshot reminders (iPhone and Android)**. It requires the accompanying server and phone changes. A Railway deployment alone cannot update participants' installed apps.

1. Commit and push this implementation to the GitHub branch connected to your Railway web service when it is ready for release. Include the server, Android, iOS, maintained CocoaPods patch installer, tests, and this guide. Keep unrelated files out of that commit.
2. In Railway, open your existing StudyTrace **web service**. Under **Settings → Source**, verify the repository and branch. Keep the existing working root directory; `/server` is recommended for a new service. Both repository roots have start files.
3. Deploy that GitHub commit. If automatic deployment is disabled, deploy the latest commit from the service's deployment controls. Redeploying an older commit will not add this feature.
4. Retain the existing PostgreSQL service and the web service's `DATABASE_URL`, `ADMIN_TOKEN`, and `PUBLIC_BASE_URL`. No new environment variable, database table migration command, cron job, or push-notification provider is needed for these reminders. The phones schedule local notifications.
5. Check Railway logs and open `https://HOST/health`, which should return `{"ok":true}`. Open `https://HOST/researcher/` and confirm the new screenshot section appears. Reload the page if you still see the older dashboard.
6. Build and distribute the updated Android app through your existing testing channel. For a local Android test, run `./android/gradlew.bat -p android :app:assembleDebug` from the repository root; the APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Install an update signed with the same key as the existing app; uninstalling to resolve a signing mismatch removes local enrollment and queued data.
7. Build the updated iOS app on a Mac with Xcode 26 or newer, using `StudyTrace.xcworkspace`, then distribute it through your existing TestFlight/internal testing process. Confirm native build and tests before distribution. The Windows workstation cannot compile or run the iPhone target. If you run `pod install`, the post-install hook reapplies the maintained timing patch.

For a new Google Play or TestFlight upload, use an Android `versionCode` or iOS build number greater than the last uploaded build. The local source changes do not by themselves publish a store build or update an installed participant app. For direct APK testing, retain the signing key and existing enrollment when installing the update.

If starting a new Railway project, complete service/database setup in [RAILWAY_SETUP.md](RAILWAY_SETUP.md#1-set-up-or-check-the-railway-service) first. Replace `https://HOST` below with the same public HTTPS origin used in `PUBLIC_BASE_URL` and phone enrollment links.

## 2. Create a separate study for the second pilot

1. Open `https://HOST/admin/` and load the admin console with `ADMIN_TOKEN`.
2. Create a new study, for example Study ID **`mindbody_pilot2`**, with a descriptive name such as **Mind-body pilot with usage screenshots**.
3. Set a participant study password and a different researcher password of at least 12 characters. Keep both securely. Set the default time zone to `America/Indiana/Indianapolis` if that remains your research team's fallback zone.
4. Click **Save study**. The successful save also verifies a database write.
5. Retain the returned enrollment URL/QR code. Generate a participant-specific invitation for each phone in step 5.

A new study ID keeps the earlier pilot's responses separate. An existing participant must explicitly join the new study on their phone; changing a dashboard does not move that phone. Upload any queued responses to the old study before switching. If reusing the old study instead, retain the participant password, export its existing data first, and record the new pilot's start/end dates.

## 3. Configure the questionnaires

1. Open `https://HOST/researcher/`, enter `mindbody_pilot2` and its researcher password, and click **Load dashboard**.
2. Under **ESM survey notifications**, paste the entire [questions.json](questions.json) array into **Survey questions JSON**. It contains all 25 questions; do not save the three questionnaires separately.
3. Use these settings after completing the short fixed-time phone test in step 6:

| Field | Value |
| --- | --- |
| Delivery mode | Randomized around listed times |
| Prompt times | `11:00, 15:00, 19:00` |
| Randomization window, minutes | `120` |
| Expiration window, minutes | `60` |
| Earliest notification, local time | `09:00` |
| Latest notification, local time | `21:00` |
| Notification title | `Mind-body study survey` |
| Notification body | `Please complete your study questionnaires.` |
| Start/end dates | Your actual pilot dates, in `MM-DD-YYYY` |

4. Click **Save ESM survey schedule**. Confirm 25 questions and three times, then reload and check the saved values.

These survey draws occupy nominal windows of 09:00–13:00, 13:00–17:00, and 17:00–21:00. The screenshot windows below are configured separately. PANAS retains its "right now" wording, PSS retains "the last month," and MWQ retains its general wording; repeating them does not change those reference periods. See the original guide and [item-codebook.json](item-codebook.json) for response codes and scoring considerations.

## 4. Enable the three screenshot reminders

Find **App usage screenshot reminders (iPhone and Android)** and set:

| Field | Value |
| --- | --- |
| Screenshot reminders | **On** |
| Delivery mode | **Random morning, afternoon, and evening** |
| Fixed test times | Leave blank; ignored in random mode |
| Minutes to upload after delivery | `60` |
| Start date | Same first day as the survey schedule, `MM-DD-YYYY` |
| End date | Same last day as the survey schedule, `MM-DD-YYYY` |

Click **Save app usage screenshot reminders**. The result should contain these three periods, with one image question each:

| Period | Local notification window | Random draw used by the scheduler |
| --- | --- | --- |
| Morning | 09:00–12:00 | 10:30 plus or minus 90 minutes |
| Afternoon | 12:00–17:00 | 14:30 plus or minus 150 minutes |
| Evening | 17:00–21:00 | 19:00 plus or minus 120 minutes |

The phone selects a time for each period, varying by installation and date. These are independent of the three questionnaire draws, so a survey and a screenshot notification can arrive close together. No minimum spacing between activities is enforced. The configured windows meet at noon and 17:00, and their boundary times are allowed.

The notification title is **App usage screenshot**. Its message asks for a screenshot of today's usage so far. There is no additional JSON to paste into this section. Saving it preserves the questionnaire schedule; saving the questionnaire section preserves these reminders.

For a new study, leave the separate **Battery screenshot notifications** and **Screen Time activity screenshot notifications (optional)** sections unsaved. The latter asks for yesterday and is a different activity. If reusing a study with either older activity enabled, use the authenticated API below to remove those schedules before this pilot; leaving a form untouched does not disable an existing schedule.

```powershell
$pilotHost = 'https://YOUR-SERVICE.up.railway.app'
$pilotStudy = 'mindbody_pilot2'
$pilotHeaders = @{ 'x-researcher-password' = 'YOUR_RESEARCHER_PASSWORD' }

# Only needed to remove previously configured, separate screenshot activities.
Invoke-RestMethod -Method Put -Uri "$pilotHost/api/v1/studies/$pilotStudy/battery-screenshot-schedule" `
  -Headers $pilotHeaders -ContentType 'application/json' `
  -Body '{"enabled":false}'
Invoke-RestMethod -Method Put -Uri "$pilotHost/api/v1/studies/$pilotStudy/screen-time-activity-schedule" `
  -Headers $pilotHeaders -ContentType 'application/json' `
  -Body '{"enabled":false}'
```

Run this only for your intended study with the updated server, then reload its dashboard. The main six-prompt setup uses the dashboard controls.

## 5. Enroll and prepare both phone types

In the researcher dashboard's **Participant join link** section, enter the participant study password and a unique participant code such as `P001`. Click **Generate join link and QR code**. Give that participant only their invitation and the instructions below. Use separate codes such as `TEST_ANDROID` and `TEST_IPHONE` for your test devices.

**Android**

1. Install the updated app. Finish onboarding/consent.
2. In **Settings**, paste/scan the generated study URL, complete the study consent, and select **Join or refresh study**.
3. Allow notifications. Check that StudyTrace's notification channel is enabled.
4. While online, tap **Refresh surveys**. This downloads both the survey and screenshot schedules.
5. Open **Settings → Digital Wellbeing & parental controls → Dashboard**, or the manufacturer's equivalent. Confirm today's total and app list are available. Menu labels vary by phone; test the actual models you will enroll.
6. The screenshot request uses the system image picker to select one image. It does not require broad photo-library, location, or Usage Access permission. Automatic Android usage logging is a separate optional collection feature; granting Usage Access does not fulfill a screenshot request.

**iPhone**

1. Install the updated iOS test build and join the new study using its invitation/QR workflow. Reopen StudyTrace while online after saving schedule changes so it downloads the current configuration.
2. Allow StudyTrace notifications. For the pilot phone test, check Focus and Scheduled Summary settings if notifications do not appear when expected.
3. Open **Settings → Screen Time**. Enable App & Website Activity if it is off. Confirm that **See All App & Website Activity → Day → Today** shows usage. A phone on which this has just been enabled may need time to accumulate data.
4. Select **this iPhone** if Screen Time shows a device selector. Use that consistently at all three requests; an all-devices view would include other devices.
5. StudyTrace uses Apple's image picker to let the participant choose a screenshot. It does not automatically read Screen Time totals from iOS.

For both platforms, use automatic date/time and the correct local time zone. Keep the app installed and open it daily while online to replenish notification scheduling and send queued data. Confirm participant code, device ID, and platform in the dashboard after enrollment/upload.

## 6. Test each platform before inviting participants

Use one real Android phone and one real iPhone. A simulator or emulator cannot establish how notifications and usage screens behave on participants' devices.

1. Within 09:00–21:00 local time, temporarily set **ESM survey notifications → Fixed exact times** to one time about 20–30 minutes ahead, keeping all 25 questions and the 60-minute expiration.
2. Set **App usage screenshot reminders → On → Fixed times for a phone test (09:00–21:00)** to a different time about 30–45 minutes ahead. Set 60 minutes to upload. Choose dates that include today, or temporarily leave dates blank. Save both sections.
3. Refresh the Android schedules and reopen the iPhone while online. Lock both phones.
4. Record actual notification arrival times. Android checks schedules using periodic background work, so the fixed test time is a target rather than a promise of minute-level delivery. The operating system can delay or suppress notifications on either platform.
5. Complete one questionnaire prompt. Verify all 25 items still appear, then upload/sync. Check the questionnaire triggers in the export.
6. Open a screenshot notification. Take a **new** screenshot of **Today**, with today's total and app list visible. Return to StudyTrace, choose the image, and submit it. Android submits after selection/preparation; iPhone reads the image text and uploads, offering a retake if extraction is unclear.
7. In the researcher dashboard, confirm the image appears under **Recent survey responses** and can be downloaded in the full export. Check `esm_trigger = app_usage_screenshot`, device ID, notification ID, and `screenshot_period`. Fixed tests use period `test`; random-mode records use `morning`, `afternoon`, or `evening`.
8. Test **Later/cancel** without selecting an image: the request should remain available until its original deadline. Test selecting an image after the deadline: it should not be accepted as a new response. Reopening does not grant another 60 minutes.
9. Test temporary loss of connectivity. Complete an image selection during the open window while offline, then reconnect. Android uses its existing upload queue; use **Upload now** to drain it during testing. iPhone queues a failed network upload for retry; reopen it online. Verify a single stored response after retry. Transmission may happen after the deadline when the response was accepted locally before it expired.
10. Restore the questionnaire random settings in step 3 and screenshot **Random morning, afternoon, and evening** mode in step 4. Set your actual dates and refresh both phones again.
11. Run both test phones through at least one full day, preferably several days, with normal screen locking and battery management. Confirm **three intended survey occurrences and three intended screenshot occurrences per day**, along with any missed/expired outcomes. Confirm random draws differ across dates and devices before enrollment.

A screenshot upload window can extend past a period boundary: a prompt delivered at 11:55 can be answered until 12:55. The image shows usage at capture time, which may differ from notification time. A late Android worker outside the configured delivery window misses that prompt rather than posting it in the next period. iOS controls background presentation; it can defer presentation, and the app rejects an out-of-window delivery when it observes it. If an iOS notification is cleared before the app observes it, the delivery evidence may be unavailable.

With six intended notifications per day, the iOS scheduler's budget of 56 pending study notifications holds roughly **nine days**, fewer if other activities consume slots. Daily opening is part of this pilot's participant instructions. See [SURVEY_TIMING.md](../../SURVEY_TIMING.md) for OS and delivery limits.

## 7. Participant instructions to copy

> Each day you will receive three questionnaire requests and three separate app usage screenshot requests. Please complete each within 60 minutes of its notification. Open StudyTrace every day while online.
>
> For a questionnaire, answer PANAS, the stress questions, and the mind-wandering questions, then submit.
>
> For an app usage screenshot, take a fresh screenshot when you respond. On iPhone, open Settings → Screen Time → See All App & Website Activity → Day → Today, and select this iPhone if asked. On Android, open Settings → Digital Wellbeing & parental controls → Dashboard, or your phone's equivalent. Show today's total and the app list.
>
> Return to StudyTrace, open the screenshot request, and choose that new image. Check for the submitted/uploaded or saved-for-upload message. If the request has closed, wait for the next one. Keep your phone's date, time, and time zone correct, and tell the research team if the usage page is unavailable.

The Android questionnaire form permits blank radio items. An answered status does not prove all 25 ratings are present; check item completeness in your export.

## 8. Monitor and export

1. Load the researcher dashboard for `mindbody_pilot2`. Inspect **Devices**, **Participant health**, **Recent survey responses**, and **Sensor coverage**. Automatic completeness/compliance summaries can combine different prompt types; use raw records for activity-specific counts.
2. Under **Sensor coverage**, select **Include screenshot and photo images**, then **Download full study export (ZIP)**. Retain the ZIP's README/codebook along with a dated copy of the schedules, app builds, [questions.json](questions.json), and [item-codebook.json](item-codebook.json). Images occupy database/export storage; monitor the Railway PostgreSQL volume during the pilot.
3. Find the raw ESM table, normally `plugin_ios_esm` for these image uploads on both platforms. Ordinary iPhone survey rows may be in `esms` or `ios_esm`. Use the export codebook to locate each source.
4. Filter screenshot responses by `esm_trigger = app_usage_screenshot` and `esm_status = 2`. Retain `device_id`, `notification_id`, `schedule_id`, `screenshot_period`, `usage_window`, `activity_date`, and available scheduled/delivery/submission times. Keep questionnaire sessions separate using their original item triggers. Timestamp fields vary between client sources; consult the column codebook.
5. The screenshot answer contains image data or an exported image reference. Downloaded images provide the evidence for manual coding. iPhone Screen Time images also pass through the existing OCR pipeline and appear in `screen_time_activity`; those values can be incomplete or wrong and require checking against the image. Android Digital Wellbeing screenshots are stored as images; this change does not add a reliable numeric OCR parser for manufacturers' different layouts. Optional Android Usage Access logging produces separate automatic data.
6. An image selection is associated with a prompt, but the app does not prove that the participant selected the correct day or a newly captured image. Inspect image contents and available capture metadata. Capture dates can be absent. Keep capture time distinct from notification and upload time in analysis.
7. **Do not add the morning, afternoon, and evening totals.** Each image shows today's cumulative usage so far. For example, 40, 100, and 160 minutes are three cumulative snapshots, not 300 minutes of use. Differences between comparable snapshots may describe intervening use, subject to screen refresh, device scope, capture-time differences, rounding, and missing images. Do not subtract snapshots across midnight or silently combine iPhone Screen Time, Battery on-screen time, and Android automatic usage as the same measure.

## 9. Stop screenshot reminders after the pilot

In **App usage screenshot reminders**, select **Off** and click **Save app usage screenshot reminders**. Refresh Android and reopen iPhone while online so each downloads the change. Verify no screenshot schedules remain in that section. This action preserves the questionnaire schedule and existing responses. Existing pending prompts can remain on an offline phone until it receives the updated configuration.

For the planned run, also set the correct end date in both activity sections. Export the collected data before changing study credentials or uninstalling the app.
