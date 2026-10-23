# Android store assets

## App icon

`play-icon-512.png` is the 512 x 512 opaque, full-bleed Google Play icon. Use it
in every default, translated, and custom listing. It uses the same existing
research artwork as the installed Android adaptive and legacy launcher icons.
Android applies launcher masks and padding, so the final icon shape can differ
while retaining the same logo. The app name is StudyTrace.

Run `./android/tools/generate-launcher-icons.ps1` with ImageMagick installed to
regenerate both the listing image and the Android launcher resources from the
original artwork. Resubmission steps are in `android/play/REJECTION_ICON_FIX.md`.

## Screenshots

These six PNGs are direct emulator captures of StudyTrace's Survey, Dashboard,
and Settings tabs. They show the app before enrollment in a study; no research
data or fictional study metrics were added.

- `phone/`: 1080 × 1920 pixels (9:16)
- `tablet/`: 2560 × 1440 pixels (16:9)

Every file is below 8 MB, and each side is between 320 and 3840 pixels.

These captures predate the launcher-branding fix. Recapture screens with changed
onboarding/dashboard brand images from the updated Android build before using
them in a new listing submission.
