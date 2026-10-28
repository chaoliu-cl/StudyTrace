# Mind body pilot setup in Railway and StudyTrace

This guide configures one survey containing your PANAS-10, Perceived Stress Scale, and Mind-Wandering Questionnaire, in that order. Participants receive the same 25 items at each of three daily prompts: 75 ratings per day. Your requested prompt hours are 09:00–21:00 in each participant's local time, with 60 minutes to respond.

Railway hosts the server and PostgreSQL database. You create the study and survey in the StudyTrace web dashboards. The phone downloads the schedule and creates its notifications; a Railway cron job is unnecessary.

**Install the updated Android and iOS builds as well as deploying the updated server.** The timing fix starts the 60-minute window from notification delivery, preserves that deadline across reopening/refreshes, and checks it on submission. Older installed clients still have the anchor-based expiration bug. Mobile operating systems can delay or suppress notifications; see [survey timing](../../SURVEY_TIMING.md) for the remaining platform limits and rollout checks.

Prepared from the repository and your three source documents on October 28, 2026. Railway menu labels can vary by account and interface version.

## Files to use

| File | Purpose |
| --- | --- |
| [questions.json](questions.json) | Complete 25-question array to paste into **Survey questions JSON**. |
| [item-codebook.json](item-codebook.json) | Item identifiers, original wording, response labels, and added numeric codes for analysis. Do not paste this file into the survey field. |

Question wording and response order follow the supplied documents. Numeric prefixes have been added to response labels: PANAS 1–5, PSS 0–4, and MWQ 1–6. The original documents show labels without these numeric codes. The server exports answer strings such as `3 - Moderately`; it does not calculate scale scores.

PANAS asks how participants feel **right now**. Every PSS item asks about **the last month**. MWQ asks about general tendencies. Repeating PSS and MWQ three times a day retains those original meanings; it does not turn them into momentary stress and mind-wandering measures. If your intended outcome is momentary change, select an appropriate adaptation for your research protocol before changing their wording.

## 1 Set up or check the Railway service

If you already have a working StudyTrace Railway service, use that service and its existing database. Create a separate pilot study in step 3 to keep test responses distinguishable from other studies. Keep an existing working service root directory as it is; both the repository root and `/server` have startup files.

For a new deployment:

1. Open [Railway](https://railway.com/) and select **New Project → Deploy from GitHub repo**.
2. Select `chaoliu-cl/StudyTrace` and the branch containing your current server, normally `main`.
3. Open the new web service. Under **Settings → Source**, set **Root Directory** to `/server`.
4. Use Node.js 20 or newer. The checked-in Railway configuration starts the service with `npm start` and checks `/health`. There is no compilation step. If Railway asks for an install command, use `npm ci`; if it asks for a start command, use `npm start`.
5. In the project, choose **New → Database → PostgreSQL**. Keep the database service and its persistent storage attached to this project.
6. Open the **web service's Variables** tab and add the settings below. Adding variables only to PostgreSQL does not configure the web service.

| Variable on the web service | Value |
| --- | --- |
| `DATABASE_URL` | A reference to the PostgreSQL service's `DATABASE_URL`, for example `${{ Postgres.DATABASE_URL }}`. Replace `Postgres` with the actual service name. Use Railway's variable reference picker if available. |
| `ADMIN_TOKEN` | A long, randomly generated secret kept by the administrator. Use a password manager to generate and retain it. |
| `PUBLIC_BASE_URL` | Your generated public HTTPS address, such as `https://YOUR-SERVICE.up.railway.app`, with no trailing slash. Set this after generating the domain below. |
| `DEFAULT_STUDY_TIMEZONE` | `America/Indiana/Indianapolis` for your server fallback time zone. Participant-local scheduling uses the phone's time zone. |

Railway supplies `PORT`; leave it automatic. `TRUST_PROXY_HOPS` defaults to `1`, which matches the repository's Railway setup.

7. In **Settings → Networking → Public Networking**, choose **Generate Domain**. Put the resulting HTTPS origin in `PUBLIC_BASE_URL`.
8. Apply/deploy the pending changes. Check the deployment logs for startup and database connection errors. Schema creation runs automatically; you do not need to create survey tables manually.
9. Keep the web service running throughout the pilot. If service sleeping/serverless is enabled for this web service, turn it off for the pilot to avoid adding cold starts to configuration downloads and uploads.

Throughout this guide, replace `https://HOST` with your service's HTTPS origin. Keep its host consistent in the environment variable, browser dashboards, and participant invitation links.

## 2 Verify the deployment

Open these addresses in a browser:

| Address | Expected result |
| --- | --- |
| `https://HOST/health` | `{"ok":true}`. This confirms the web process responds. |
| `https://HOST/status` | Reports `database: "configured"`. This confirms the database variable exists, not that every database operation succeeds. |
| `https://HOST/admin/` | Admin access form. |
| `https://HOST/researcher/` | Study ID and researcher password form. |

The authenticated study save in the next step verifies a real database write. If the dashboard loads in setup mode or an API returns `503`, check `DATABASE_URL` on the web service. If the process cannot start or a save fails with a database error, inspect Railway's deployment logs and the PostgreSQL service status.

## 3 Create the pilot study

1. Open `https://HOST/admin/`.
2. Enter the Railway `ADMIN_TOKEN` and click **Load admin console**.
3. Under **Create or update a study**, fill in:

| Field | Suggested value |
| --- | --- |
| Study ID | `mindbody_pilot` |
| Study name | `Mind-body survey pilot` |
| Participant study password | A new password used only for enrolling/uploading participant phones. |
| Researcher password | A different secret of at least 12 characters, kept by the research team. |
| Default time zone | `America/Indiana/Indianapolis` |

4. Click **Save study** and confirm the operation succeeds. Retain both passwords in your password manager; the server stores hashes and cannot recover their original text.
5. Keep the returned study URL/QR code for enrollment. You can generate participant-specific invitations later.

These three secrets have different roles: `ADMIN_TOKEN` manages all studies, the researcher password accesses this study's dashboard and exports, and the participant password goes into the enrollment URL. Participants receive only their enrollment link or QR code.

If editing an existing study, leave the participant password blank to preserve its current value and keep enrolled phones working. Use a distinct study ID for this pilot if the proposed ID already belongs to another project.

## 4 Add all three questionnaires as one survey

1. Open `https://HOST/researcher/`.
2. Enter Study ID `mindbody_pilot` and the **researcher password**, then click **Load dashboard**.
3. Scroll to **ESM survey notifications**. ESM means the ordinary questionnaire prompts.
4. Replace everything in **Survey questions JSON** with the complete contents of [questions.json](questions.json), including its opening `[` and closing `]`.

To copy the file without retyping, run this PowerShell command from the repository root:

```powershell
Get-Content -Raw -Encoding UTF8 .\docs\studies\mind-body-pilot\questions.json | Set-Clipboard
```

5. Enter the schedule settings below. For the first phone test, temporarily use the fixed schedule in step 6 instead; then restore these settings.

| Dashboard field | Value |
| --- | --- |
| Delivery mode | `Randomized around listed times` |
| Prompt times, 24-hour HH:MM | `11:00, 15:00, 19:00` |
| Randomization window, minutes | `120` |
| Expiration window, minutes | `60` |
| Earliest notification, local time | `09:00` |
| Latest notification, local time | `21:00` |
| Notification title | `Mind-body study survey` |
| Notification body | `Please complete your study questionnaires.` |
| Start date | Your pilot's first day, in `MM-DD-YYYY`, or blank for the initial test. |
| End date | Your pilot's last day, in `MM-DD-YYYY`, or blank for the initial test. |
| Survey questions JSON | Entire `questions.json` array. |

6. Click **Save ESM survey schedule**. Inspect the result: there should be 25 questions and the three intended times. Reload the dashboard and confirm the saved questions/settings load correctly.

The randomization setting is **plus or minus** 120 minutes around each time, producing nominal local windows of 09:00–13:00, 13:00–17:00, and 17:00–21:00. There is one draw per window. This differs from drawing three unrestricted times across the entire day. The windows meet, so prompts can be close together at their boundaries.

Keep all 25 questions in this single schedule. Saving each questionnaire separately replaces the ordinary ESM schedule; it does not add a separate questionnaire to the previous save. The optional **Question templates → Add to survey** button appends questions, so it is unnecessary when using the supplied JSON. The Battery and Screen Time screenshot forms configure separate activities and are unnecessary for these surveys.

Schedule updates become effective on phones after the phones download them. On Android, use **Refresh surveys** after every test change. Avoid changing item wording or response codes after pilot enrollment without retaining a dated copy of the previous configuration.

## 5 Enroll a phone

The following phone steps describe the current Android app. Use a physical phone to evaluate background delivery; an emulator is useful for checking layout and basic submission.

1. In the researcher dashboard's **Participant join link** section, enter the **participant study password** and a test participant ID such as `TEST001`.
2. Click **Generate join link and QR code**. The generated link safely encodes the password. Its general form is:

   ```text
   https://HOST/index.php/webservice/index/mindbody_pilot/PARTICIPANT_PASSWORD?participant=TEST001
   ```

3. Install/open the current StudyTrace Android build. Complete the consent screen.
4. Open the app's **Settings**, paste or scan the generated study URL, complete the study consent, and tap **Join or refresh study**.
5. Allow notifications and check that StudyTrace's notification channel is enabled in Android settings. The questionnaire feature does not require location permission or Usage Access. Other study sensor features have their own settings and permissions.
6. While online, tap **Refresh surveys**. Confirm the study enrollment succeeds and that the phone appears under **Devices** in the researcher dashboard after an upload. Use **Upload now** to send queued rows during testing.
7. Keep the phone's date, time, and time zone set correctly, preferably automatically. Android computes these survey times in the phone's current local time zone. The server fallback time zone is for summaries when no participant time zone has been reported.

Give each real participant a distinct code such as `P001`, `P002`, and `P003`; generate a separate invitation for each. Retain any participant-code lookup separately from the response exports. Check the code and device ID after enrollment, especially after an app reinstall or phone replacement.

## 6 Test one complete survey before inviting participants

1. Use only your test phone initially. In **ESM survey notifications**, change delivery mode to **Fixed exact times**, choose one time about 20–30 minutes ahead in the phone's local time, set expiration to `60`, and retain the same 25 questions. Use dates that include today, or leave both dates blank for this test. If testing outside 09:00–21:00, temporarily clear both notification-hour fields and restore them before the randomized pilot.
2. Save, then tap **Refresh surveys** on the phone while it is online. Lock the phone and leave it connected to the internet for this first test.
3. When the notification arrives, record its actual arrival time. Open it and verify the questionnaire order, all 25 items, and the correct five/five/six response choices. Android currently displays one scrolling form with a single submission action. iOS can present question progression differently.
4. Answer every item and submit. Tap **Upload now** afterward. Reload the researcher dashboard, then download the study export as described in step 7.
5. For one fully completed Android prompt, verify 25 raw ESM rows sharing the same device and `notification_id`, with 25 distinct triggers: `panas10_01`–`panas10_10`, `pss10_01`–`pss10_10`, and `mwq_01`–`mwq_05`. Check actual answer strings against `item-codebook.json`.
6. Test dismissal and an unanswered prompt as separate scheduled occurrences. Check that the outcomes reach the server. Test an offline submission followed by reconnection and **Upload now** to confirm queued data uploads. A phone that sleeps through a response window can report a missed prompt rather than deliver it late.
7. Test the actual target phones with the screen locked and normal battery management. Android's scheduler uses periodic background work with a 15-minute interval; the operating system can delay it longer, so that interval is not a maximum delivery delay. Force-stopping the app can prevent background work until it is opened again.
8. Restore **Randomized around listed times**, `11:00, 15:00, 19:00`, randomization `120`, expiration `60`, and notification hours `09:00`–`21:00`. Set the actual pilot dates. Save and refresh the phone again. Run a short multi-day pilot, preferably at least a week, to observe delivery, burden, missing answers, and uploads.

**Completeness is not currently enforced on Android.** The supplied questions use radio options and disable the extra N/A choice where supported, but a participant can still submit blank items on Android. An `answered` status does not establish that every item is filled in. Treat blank answers as missing and count completed items explicitly.

## 7 Monitor and export responses

1. Open `https://HOST/researcher/`, load `mindbody_pilot`, and inspect **Devices**, **Participant health**, and **Sensor coverage**.
2. Under **Sensor coverage**, click **Download full study export (ZIP)**. For these questionnaires, leave **Include screenshot and photo images** unchecked. The ZIP includes raw tables, derived exports, device information, withdrawals, a column codebook, and a README.
3. Find the raw ESM response table. Android uploads it as **`plugin_ios_esm`**, despite the name. iOS versions can use other ESM table names such as `esms` or `ios_esm`; retain the full export and consult its codebook.
4. Use `esm_trigger` to identify each item and `esm_user_answer` for its selected label. On Android, group a survey session by **device ID plus `notification_id`**; each day contains three intended sessions, so grouping only by participant and date would combine them.
5. Inspect `esm_status`: Android uses `2` for answered, `1` for dismissed, and `3` for expired, with missed occurrences also represented through client telemetry. Do not count dismissed/expired rows as responses or treat an empty answer as the numeric PSS value zero.
6. Preserve `schedule_id`, prompt/delivery/answer timestamps, time zone, and client events so you can evaluate actual response windows and delivery delays. Android timestamp fields such as `timestamp` and `double_esm_user_answer_timestamp` use epoch milliseconds. Read the export's column codebook for each platform before converting dates.
7. Retain `questions.json`, `item-codebook.json`, pilot dates, app version, and the saved schedule settings with each dated export. Verify scale scoring against your chosen instrument guidance before analysis. No total or subscale scores are produced by this setup.

`survey_quality` and `participant_health` summarize operations and response quality; they are not PANAS, stress, or mind-wandering scores. Dashboard compliance is an operational estimate, so verify session counts against the raw response and notification records.

## 8 Updated timing behavior and platform limits

Both updated clients preserve a deadline of delivery plus the configured response duration, and reject submissions at or after that deadline. Random offsets vary by installation, date, and slot. iOS uses separately dated notifications instead of repeating one randomized clock time every day. Reopening the app or refreshing the schedule does not restart an observed response window.

Notification hours limit new prompts. A survey delivered at 20:55 remains answerable until 21:55. Android checks those hours immediately before posting; a worker arriving too late records a missed occurrence. iOS schedules its triggers inside those hours, suppresses late foreground notifications, and rejects late deliveries when observed. iOS controls background presentation and can still defer a notification while StudyTrace is suspended.

The operating system can suppress delivery on either platform. iOS also has a finite pending-notification queue; at three prompts per day the updated scheduler can hold about 18 days, fewer if other study activities use the queue. Ask participants to open the app daily to replenish notifications and observe uploads. If an iOS notification is cleared before the app sees it, its delivery time may be unavailable; the app does not invent a new response window.

See [Survey response windows on Android and iOS](../../SURVEY_TIMING.md) for the maintained CocoaPods patch, testing commands, and deployment steps. Native iOS build/simulator verification requires macOS. Validate both physical platforms before participant rollout.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Dashboard works but a study cannot be saved | `DATABASE_URL` must be on the web service and point to the running PostgreSQL service. Check logs and credentials. `/health` alone does not verify the database. |
| Admin authentication fails | Enter the deployed `ADMIN_TOKEN`, not either study password. Confirm variable changes were deployed. |
| Researcher authentication fails | Use the correct study ID and its researcher password. Older studies without a researcher password need one set through the admin console. |
| Phone cannot join | Use the dashboard-generated HTTPS invitation from the same host; check participant password and study ID. |
| Only the default Current activity question appears | Replace the survey JSON with the full questions array, save, and tap **Refresh surveys** on the phone. |
| Only one of the three questionnaires appears | Paste all 25 questions in one save. Successive ordinary ESM saves replace the previous survey. |
| No notification arrives | Check enrollment, consent, notification permission/channel, active dates, local clock/time zone, and downloaded settings. Allow for OS delays; reopen after force-stop. Confirm the form used was **ESM survey notifications**. |
| A changed schedule does not appear immediately | Save on the website, then **Refresh surveys** while the phone is online. Automatic configuration refresh depends on background execution. |
| Responses do not appear in Railway yet | On the phone, reconnect and tap **Upload now**. Check the correct study and raw ESM table in the export, then inspect upload/deployment logs. |
| Participant health says answered but some items are blank | Android permits incomplete forms. Count nonblank answers using the item codebook; do not infer completeness from session status. |

For subsequent pilot days, keep the same invitation host and study credentials, monitor uploads, and export dated copies regularly. Before ending data collection, test schedule end-date behavior on the platforms in use and verify phones stop creating new prompts after their next configuration refresh.
