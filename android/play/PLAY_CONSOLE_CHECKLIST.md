# StudyTrace Google Play submission checklist

## Build identity

- Package: `edu.studytrace.android`
- Version: `1.0` (`versionCode` 1)
- Target API: 36
- Privacy policy: `https://liu-chao.site/StudyTrace/privacy/`
- Release artifact: `app/build/outputs/bundle/release/app-release.aab`

The Google Play Developer Account ID identifies the console account. Do not put
it in the application, manifest, signing configuration, or repository secrets.

## Required before uploading

- Publish the updated cross-platform privacy policy from `docs/privacy/`.
- Create or select the Play Console app with package `edu.studytrace.android`.
- Enroll in Play App Signing and securely create/register the upload key.
- Build the AAB with the four `STUDYTRACE_UPLOAD_*` signing values described in
  `android/README.md`; verify the certificate is the registered upload certificate.
- Supply a 512 x 512 Play icon, 1024 x 500 feature graphic, phone screenshots,
  app category, contact email, and support website.
- Set the app's target audience accurately. Do not select children unless every
  deployed study and its parental-consent process complies with Families policy.

## App content declarations

- Privacy policy: use the URL above.
- Data safety: start from `DATA_SAFETY_DRAFT.md` and validate answers with the
  research institution and every production server operator.
- Sensitive permissions / background location: declare the continuous research
  mobility/context feature and explain why it is core to the studies offered.
- Foreground service: declare the `location` type and provide the required video.
- Health apps: complete the declaration for all apps. If any distributed study
  is health-related human-subjects research, declare that use and verify approved
  informed consent and applicable institutional/legal requirements.
- Ads: declare no ads only if no study configuration or server adds advertising.
- App access: provide a working review study URL and consent/reviewer instructions;
  do not give reviewers a production participant credential.
- Content rating: complete the questionnaire based on possible survey content.

## Review video

Use an Android device and show, in order:

1. Opening StudyTrace and the in-app privacy policy link.
2. Joining a dedicated review study and acknowledging its consent.
3. Tapping Request Location Permission.
4. The prominent background-location disclosure in full.
5. The Android foreground and "Allow all the time" permission steps.
6. Starting collection and the persistent foreground-service notification.
7. Stopping collection and leaving the study, including the delete-data option.

The background-location and foreground-service forms may use the same short video
if it visibly demonstrates every item required by both forms.
