# Fixing the Google Play icon mismatch

The supplied rejection identifies a Misleading Claims policy issue:
the installed app shows a blue placeholder with three white bars, while the
Play listing shows the research logo with a magnifying glass, person, location
pin, chat bubble, and wireless symbol. The app name in the evidence is already
StudyTrace. This notice does not identify a background-location violation.

## Changes in this build

- Replaced the placeholder launcher icon with the existing research logo.
- Added an Android adaptive icon, a round-icon declaration, and density-specific
  launcher images, all using the same research artwork.
- Updated the onboarding and dashboard brand images to use the launcher logo.
- Generated `AppStoreAssets/Android/play-icon-512.png` as the matching opaque,
  square 512 x 512 Play listing icon without baked-in rounded corners.
- Increased the version to 1.0.1, version code 2. The package remains
  `edu.cedarville.studytrace`.

The original artwork is
`StudyTrace/studytracelogo.icon/Assets/ChatGPT Image May 17, 2026, 11_33_24 PM 2.png`.
Regenerate the Android and Play icon files with ImageMagick installed:

```powershell
./android/tools/generate-launcher-icons.ps1
```

Android launchers apply different shapes and padding. The installed icon and
the store icon must show the same recognizable artwork; their masks do not
need to be pixel-identical.

## Steps to complete in Play Console

1. Open the rejected app, and find its default store listing under **Store
   presence > Main store listing** (navigation labels can vary). Keep the app
   name **StudyTrace** and upload
   `AppStoreAssets/Android/play-icon-512.png` as its app icon.
2. Check every translated listing and every custom store listing. Replace any
   different logo with the same icon and keep the StudyTrace name consistent.
   Review screenshots and the feature graphic for outdated branding; replace
   screenshots that no longer reflect the current Android interface with real
   captures from this build. The existing onboarding/dashboard brand badges
   changed in this fix.
3. Build a new release bundle with the existing registered upload key. Do not
   change the package name or create a new signing key to resolve an icon issue.
   The local Gradle signing configuration is used by the existing build setup:

   ```powershell
   ./android/gradlew.bat -p android :app:bundleRelease
   ```

   Upload `android/app/build/outputs/bundle/release/app-release.aab`. This fix
   uses version code 2. If Play has already received version code 2 or higher,
   increase `versionCode` in `android/app/build.gradle.kts` above the highest
   uploaded code and rebuild before uploading. Verify the upload certificate
   against the **Upload key certificate** in Play Console's App integrity page.
   The locally built bundle's signer has SHA-256 fingerprint
   `FE:71:BC:3C:77:07:A9:8B:44:81:5D:AE:F7:73:B3:2E:4F:39:7D:42:7B:50:83:81:DD:32:C2:AE:58:79:88:47`.
4. Install this new build through an internal test track and confirm the
   launcher shows the research logo and the label StudyTrace. Also open the app
   and check the branding on onboarding and the dashboard. Installing over an
   existing app preserves its consent and enrollment state; do not clear a real
   participant's app data merely to test the icon. If an old icon is cached,
   restart the test device's launcher or reboot the test device first.
5. Include the corrected release and listing changes in the changes sent for
   review. Updating the listing alone leaves the old placeholder inside the
   previously uploaded binary, so submit the rebuilt AAB as well. Check
   **Publishing overview** for pending changes and use **Send for review** when
   the corrected assets and release are ready.

## Suggested reviewer explanation

Use this after updating the listings and uploading the corrected bundle:

> We corrected the installed app icon to use the same StudyTrace research logo
> shown in our Google Play store listing. We replaced the placeholder launcher
> icon, added adaptive and round launcher support, and aligned the in-app brand
> images. The installed app name remains StudyTrace. We also checked the default,
> translated, and custom store listings for consistent branding. The corrected
> Android App Bundle is included in this submission.

## Other declarations

Keep the existing background-location and data-safety declarations accurate.
This icon fix does not change permissions, data collection, study consent, or
research functionality. Google may evaluate those items separately in a later
review.

## Local verification

The debug APK and signed release AAB built successfully. Debug lint and release
vital lint completed without errors; non-blocking lint warnings remain. The
API 36 emulator successfully launched the app, and its App info screen and
StudyTrace dashboard displayed the research logo and the StudyTrace name.
The release bundle includes the new icon resources and was signed using the
existing local upload-key configuration. Play Console submission and an internal
track installation still need to be completed by the publisher.
