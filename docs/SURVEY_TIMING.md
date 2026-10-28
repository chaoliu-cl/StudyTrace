# Survey response windows on Android and iOS

Updated clients measure a positive survey expiration value from notification
delivery, independently of the original anchor and randomized offset. With
`expiration: 60`, both an early 10:30 prompt and a late 11:30 prompt stay open
for an hour from their respective delivery times. Reopening a prompt or
refreshing its schedule does not move its persisted deadline. Submissions at
or after the deadline are rejected, including a form left open beforehand.

## Configure the mind body pilot

After deploying the server and installing the updated Android and iOS builds,
save these values in the researcher dashboard's ESM survey form:

| Setting | Value |
| --- | --- |
| Delivery mode | Randomized around listed times |
| Prompt times | `11:00, 15:00, 19:00` |
| Randomization window | `120` minutes |
| Expiration window | `60` minutes |
| Earliest notification | `09:00` local time |
| Latest notification | `21:00` local time |

Paste all 25 items from [questions.json](studies/mind-body-pilot/questions.json)
in one survey. The three nominal draw windows are 09:00–13:00, 13:00–17:00, and
17:00–21:00. Each installation draws separately for each date and anchor, and
keeps the same draw across refreshes. There is no minimum spacing between
adjacent windows. A prompt delivered at 20:55 remains answerable until 21:55;
notification hours restrict new prompts, not existing response windows.

API schedule saves accept `prompt_window_start` and `prompt_window_end`. Both
must be valid same-day times with start before end, or both blank to disable
the restriction. Configs sent to phones use `studytrace_window_start` and
`studytrace_window_end`. Existing schedules without these fields retain their
previous unrestricted hours until saved with explicit bounds.

Android users should tap **Refresh surveys** while online. iOS users should
reopen the app while online to refresh the remote schedule. Server deployment
alone does not repair an older installed app. Test with a new occurrence after
updating; an Android prompt delivered before the update retains its saved
deadline. Pending legacy iOS notifications are replaced during schedule refresh.

## Android behavior

`PromptPlanner` uses the installation's persistent device ID in its random seed.
The repository records delivery when the notification is successfully posted
and persists an absolute deadline of delivery plus the configured duration.
Opening and submitting both use that deadline. Notification timeouts remove
expired notifications without waiting for the next background worker.

The periodic worker remains a fallback for delivery and uploads. It normally
checks every 15 minutes, but Doze, battery management, or force-stop can delay
it longer. Catch-up is permitted only until randomized scheduled time plus
the expiration duration and only inside the configured delivery hours. A
delayed worker arriving outside that interval records a missed occurrence.
Disabled notification permission/channels are not counted as successful
deliveries. The app does not request restricted exact-alarm permission.

## iOS behavior

The maintained AWARE patch generates distinct, nonrepeating calendar
notifications containing full dates. A persistent installation seed gives a
fresh, stable draw for each date and schedule slot. Schedule start/end dates
are inclusive local dates. Refreshes rebuild future requests and retain
delivered deadlines; significant time changes also rebuild future requests.

The scheduler reserves capacity for other app notifications and fills the
earliest available occurrences, up to a budget of 56 pending notifications.
At three prompts per day, this holds about 18 days of prompts, fewer if other
study activities also use notifications. Reopening the app or a permitted
background refresh replenishes the queue. Ask participants to open StudyTrace
daily so replenishment and uploads are observed during the pilot.

`UNNotification.date` supplies the delivery time when a notification is
presented, tapped, or found in Notification Center. The app persists that time
and its deadline, rather than starting a fresh window when the app opens. A
survey becomes available only after delivery has been observed. If someone
clears the notification before the app can observe it, iOS may provide no
delivery evidence; the app does not invent a new response window from a tap
or from the planned time. One-by-one survey pages remain bound to the same
occurrence and check its deadline on every Next/Submit action.

iOS controls presentation of local notifications while the app is suspended.
Focus, notification settings, or a powered-off phone can suppress or defer
presentation. The app schedules triggers inside the chosen hours, suppresses
out-of-hours foreground notifications, and rejects/removes observed deliveries
outside those hours. It cannot intercept a delayed background presentation at
the moment iOS shows it. Neither platform can guarantee three visible prompts
per day regardless of operating-system settings or device availability.

Zero expiration preserves the end-of-local-day convention. The pilot should
use 60, not zero. Notification audit metadata and Android response rows retain
scheduled/delivered/expiry timestamps for analysis. iOS item rows use the same
delivery timestamp throughout one questionnaire session; the notification audit
provides its occurrence identifier and timing metadata.

## Maintaining and verifying the iOS patch

`patches/aware-esm/StudyTraceESMTiming.inc` owns the policy. The checked-in AWARE
manager includes it directly. `scripts/apply_aware_timing_patch.rb` applies the
manager/header/controller integration and restores HH:MM parsing to a fresh
AWARE 1.14.18 installation. The Podfile pins that tested version and reapplies
the patch after CocoaPods installs; CI verifies that reapplying it leaves the
committed sources unchanged. Review the patch before updating AWARE versions.

On macOS, run the existing iOS CI workflow or:

```sh
ruby scripts/apply_aware_timing_patch.rb
xcodebuild test -workspace StudyTrace.xcworkspace -scheme StudyTrace \
  -destination 'platform=iOS Simulator,name=YOUR_AVAILABLE_IPHONE' \
  -only-testing:StudyTraceTests CODE_SIGNING_ALLOWED=NO
```

The XCTest cases cover early/late delivery, exact expiry boundaries, immutable
deadlines on repeated observation, independent daily draws, and local hours.
Android JVM tests cover these timing rules, stale delivery, and daylight-saving
transitions. Server integration tests cover notification-hour defaults,
validation, and disabling bounds. Xcode/iOS Simulator verification requires
macOS; a Windows Android build does not validate the Apple build.

Before participant rollout, use a test study and both physical platforms to
check locked-screen delivery, offline answering and later upload, reopening
near expiry, submitting after expiry, background refresh, notification
permissions, end dates, and time-zone changes. Compare raw answer times with
delivery/deadline telemetry; an answered session can still have missing items.
