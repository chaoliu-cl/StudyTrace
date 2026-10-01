# App Store submission notes for StudyTrace

Everything App Store Connect asks for that is not in the build itself. Items in
`<angle brackets>` must be filled in before submitting.

## 1. Before you submit

1. **Create a review study** on the production server (`/admin/` → Create or update a study), for example study ID `appreview`.
2. **Publish its consent** in `/researcher/` → Participant consent. Every field is required. Use wording your IRB approved, or clearly label it as a demo consent for App Review.
3. **Open screenshot prompts** so the reviewer can see them: in `/researcher/`, save a Battery screenshot schedule and a Screen Time screenshot schedule with a prompt time that has already passed today and a long expiration window (for example 1440 minutes). Save an ESM survey schedule the same way.
4. **Get the join link and QR code** for the review study (`/admin/` or `/researcher/` → join link), with participant ID `APPREVIEW`. Put the link in the notes below and attach the QR image to the review notes or a screenshot.
5. **Deploy the server** with the consent changes and **publish the website** (`docs/` deploys to https://liu-chao.site/StudyTrace/ when merged to `main`), so the privacy policy and support pages are current.
6. **Archive and upload** from Xcode (Product → Archive). The build number is 8; increase it for every upload.
7. Watch for an App Store Connect email after upload. If it reports **ITMS-90683 (missing purpose string)** for `NSMicrophoneUsageDescription` or `NSMotionUsageDescription`, the AWARE framework links audio and barometer code the app never turns on. Add the string it names to `StudyTrace/Info.plist` and `en.lproj`/`ja.lproj/InfoPlist.strings`, for example: "StudyTrace does not use the microphone unless a research study you join asks for it and you allow it."

## 2. App Review Information → Notes (paste and fill in)

```
StudyTrace is a research participation app used by university research teams. Participants join a study with a link or QR code from the research team; there are no user accounts or sign-in.

TO TEST
1. Open this study link on the device (or tap "Join a Study" on the Surveys tab and paste it, or scan the attached QR code):
   <https://<server>/index.php/webservice/index/appreview/<participant password>?participant=APPREVIEW>
2. StudyTrace shows the study's consent form: purpose, duration, procedures, risks, benefits, confidentiality, withdrawal, a contact, and the ethics board approval. Tap "I Agree".
3. iOS then asks for notification and location permission. Every feature still works if you decline.
4. Surveys tab: tap the survey button to answer a survey. Tap "Battery screenshot upload available" (or the Screen Time button), follow the steps to take the screenshot in iPhone Settings, then choose it from the photo picker; it uploads with a confirmation.
5. Settings tab → Leave Study: stops collection, deletes the study data on the device, and lets the participant delete the data already uploaded to the study server.

BACKGROUND LOCATION
Studies that measure daily mobility (for example distance travelled and time at home) record location in the background. This is described in the study's consent form and the location permission prompt, starts only after the participant agrees to the consent, and stops when they leave the study. The app works with "While Using" or no location permission; StudyTrace explains "Always" once per study and does not ask again.

SCREEN TIME / APP USAGE
StudyTrace does not use the Screen Time API or FamilyControls. App-usage information comes only from screenshots of iPhone Settings → Battery or Settings → Screen Time that the participant chooses to upload. The phone reads the screenshot's text on-device and uploads it with the image to the study's own server.

RESEARCH ETHICS (Guideline 5.1.3)
Each study publishes its IRB-approved consent on its server; the app requires it before joining and shows it again if the research team changes it. The review study's consent: <IRB name>, protocol <number>. Approval documentation is available on request: <contact email>.

DATA
Data is uploaded over HTTPS only to the server of the study the participant joined. No advertising, analytics SDKs, or tracking. Privacy policy: https://liu-chao.site/StudyTrace/privacy/

Contact for review questions: Chao Liu, chaoliu@cedarville.edu
```

## 3. App information

| Field | Value |
|---|---|
| Privacy Policy URL | https://liu-chao.site/StudyTrace/privacy/ |
| Support URL | https://liu-chao.site/StudyTrace/support/ |
| Marketing URL (optional) | https://liu-chao.site/StudyTrace/marketing/ |
| Category | Education (set in the build; Medical or Health & Fitness are alternatives if your studies are health research) |
| Devices | iPhone only. Screenshots: 6.9-inch iPhone (1320 × 2868 or 1290 × 2796); the 6.5-inch set is optional |
| Sign-in required | No (leave the demo account fields empty; the study link above is the access path) |
| Age rating | Answer "None" to the content questions. Choose 17+ only if your studies are restricted to adults and you want the store to reflect that |
| Export compliance | The app uses only standard HTTPS encryption provided by iOS. `ITSAppUsesNonExemptEncryption` is `NO` in Info.plist, so App Store Connect will not ask |
| Distribution | Public, or **Unlisted** if only invited participants should find it (request unlisted distribution from Apple after approval) |

## 4. App Privacy questionnaire

Matches `StudyTrace/PrivacyInfo.xcprivacy`. For every type below: **linked to the user: Yes** (research teams can link the device ID to a participant code), **used for tracking: No**, **purpose: App Functionality**.

| App Store category | Data type | What it is |
|---|---|---|
| Location | Precise Location | GPS location for studies that collect it |
| User Content | Photos or Videos | Survey photo answers and Battery / Screen Time screenshots |
| User Content | Other User Content | Survey answers, consent agreement records |
| Identifiers | Device ID | Random ID generated by the app |
| Usage Data | Other Usage Data | Screen lock/unlock times, survey delivery and open events |
| Diagnostics | Other Diagnostic Data | App/iOS version, iPhone model, battery state, permission status, upload results |

Not collected: contact info, health and fitness, financial info, contacts, browsing or search history, purchases, sensitive info, audio, advertising data.

Data is collected by the research team operating the study server, but Apple counts it as collected by the app because the app sends it off the device.

## 5. What changed for review in this build

- Per-study informed consent before joining, with all Guideline 5.1.3(iv) elements and IRB details required.
- No permission prompts before consent. "Always" location is explained once per study and is optional.
- Leave Study (with deletion of uploaded data) and the hosted privacy policy are in Settings.
- Developer-only settings, raw sensor screens, and the survey-schedule QR import are compiled out of release builds.
- Push notifications removed (unused); survey reminders are local notifications.
- iPhone only.
