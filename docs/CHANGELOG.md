# Changelog

## November 2, 2026 — iPhone build 17

- Dashboard shows only Battery Usage Screenshot, including in demo mode.
- Survey and location cards are omitted from Dashboard. Questionnaires remain
  available through Surveys and their notification links.
- Returning to Dashboard refreshes the Battery section without automatically
  switching tabs when a questionnaire is available.
- Reload removes old card views and keeps a single Battery section.

## November 2, 2026 — iPhone build 16

- Notification taps open the specific questionnaire or screenshot task and keep
  its original occurrence deadline, including overlapping requests.
- Configuration refresh preserves unchanged surveys and retains cached
  schedules after failed downloads, without a temporary empty-schedule gap.
- Screenshot uploads accept images when OCR headings are missing and complete
  successfully without repeated wrong-screen or retake prompts. Researcher
  review flags and original images remain available.
- Screen Time extraction handles inline app/time rows and cropped app lists;
  missing daily totals remain missing.

See [release and pilot checks](IOS_NOTIFICATION_SCREENSHOT_FIXES.md).
