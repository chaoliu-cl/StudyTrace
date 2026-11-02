# iPhone notification and screenshot fixes — November 2, 2026

App version **1.0.0, build 16** includes these fixes. The backend changes improve
new screenshot extraction and feedback; participants need the updated iPhone
build for notification routing and the removal of the local screenshot warning.

## Notification taps

Previously, tapping a study notification only selected the Surveys tab. It did
not open the questionnaire. A questionnaire form also chose the first available
schedule, which could belong to another overlapping request.

The updated app passes the notification's schedule and occurrence identifiers
to the Surveys screen and opens that questionnaire, or the matching screenshot
instructions. The form stays bound to that request and its original delivered
response deadline. Expired, answered, or removed requests show an unavailable
message rather than opening another survey or starting a new response window.
If another form/picker is open, its answers are preserved and the new request
waits for the Surveys screen to be available.

Configuration refreshes no longer leave an asynchronous gap with no cached
surveys. Unchanged configurations retain their existing Core Data objects;
failed or invalid downloads retain the last usable schedules. Refreshing does
not extend delivered deadlines.

## Screenshot uploads

The previous phone-side check relied on a few English/Japanese OCR headings.
A scrolled companion image could omit those headings even though it was a
legitimate Screen Time screenshot. Successful uploads could also trigger a
second retake prompt when extraction was incomplete.

The updated flow uploads the participant's selected images without classifying
them as the wrong screen based on OCR. A successful upload completes the request
and shows a success message. Multiple images and offline queuing remain supported;
transport errors and expired response windows still receive their own messages.

OCR quality remains visible to researchers through `needs_review`, extraction
status, and image links. Incomplete recognition does not mean the image is invalid.
The parser now handles app names and durations joined on one visual line, as
produced by Apple Vision, and cropped app lists without the top heading. A missing
daily total stays missing; it is not replaced by the first app's usage duration.
Original images remain available for review. These parsing changes apply to new
uploads; historical records are not deleted or automatically rewritten.

## Distribute the iPhone update

1. Open the build-16 `.xcarchive` in Xcode Organizer, or archive the merged source
   using `StudyTrace.xcworkspace`, scheme **StudyTrace**, Release configuration.
2. Use **Distribute App → App Store Connect** and upload through your existing
   Apple developer account. Follow the signing choices offered for your account.
3. In App Store Connect, wait for processing and any required TestFlight review,
   complete any requested compliance information, then add the build to the
   existing pilot's TestFlight group. An archive on this Mac is not a published
   TestFlight build.
4. Ask participants to update over the existing installation, using the same
   app and study enrollment. They do not need to leave and rejoin the study.
5. After saving the intended schedules in the researcher dashboard, ask them to
   open StudyTrace online. Pull down on the StudyTrace tab to refresh study
   settings if needed. Leave notifications enabled and open the app daily.
6. Test a newly scheduled notification after refreshing. An old notification
   may refer to an expired or replaced request and correctly show unavailable.

## Validation and pilot checks

Automated coverage includes opening the exact questionnaire while another sorts
first, occurrence-specific deadlines, answered/missing requests, stable cached
objects across refresh, failed-download cache preservation, inline/cropped OCR
rows, and successful-upload feedback that retains research review flags without
requesting another participant upload. Maintained AWARE patches reapply cleanly.

Before resuming the pilot, test on a physical iPhone:

1. Use a separate test study with one ordinary questionnaire and one screenshot
   task at distinct future fixed times, with a 60-minute response window. Refresh
   the phone while online.
2. Tap a questionnaire notification from the background, then test again after
   an app relaunch. Confirm its actual questions open without an extra Surveys
   button tap. With two open requests, confirm the tapped one is selected.
3. Open the screenshot notification. Select a top-of-screen image and a scrolled
   companion image. Confirm both upload and the task completes without a wrong-
   screen/retake loop. Review the images and any quality flags in the dashboard.
4. Check an expired/completed notification cannot reopen the questionnaire or
   reset its deadline. Check temporary loss of connectivity queues the images
   and uploads them when the app reconnects.

Simulator tests do not establish real-device notification delivery under Focus,
power-saving settings, or background restrictions. The participant's specific
reported screenshot was not available in this conversation for image-level testing.

Local validation on November 2: Xcode 26.6 build-for-testing and **26 iPhone
simulator tests passed** on iOS 26.5. The **19 server checks and AWARE smoke suite
passed**, including screenshot-upload regressions. Both AWARE patch installers
were verified idempotent. The Release archive is build 16 and its Apple
Development signature verifies; TestFlight upload/distribution remains separate.
