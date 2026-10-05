# StudyTrace

StudyTrace is a research-participation platform for collecting consented mobile
sensor, survey, and device-usage data. Participants join a study using the
secure invitation supplied by their research team, review the study's consent
terms, choose platform permissions, and can stop collection or leave the study
at any time.

The repository contains native iPhone and Android clients, the StudyTrace
server, public support/privacy pages, and store-submission assets.

## Privacy and consent

StudyTrace is designed for approved research rather than advertising or
consumer profiling.

- First launch explains the app, the categories of data a study may request,
  research use, withdrawal, and platform permissions.
- Upfront informed consent cannot be skipped. Study-specific consent is also
  required before enrollment and collection.
- Android app-activity collection records package/app labels, foreground-use
  duration, launch counts, and screen lock/unlock events—not content viewed or
  typed inside other apps.
- Study data is queued on the device and sent only to the research server
  configured by the study invitation.
- The clients contain no advertising SDK and do not use study data for
  cross-app advertising tracking.
- Participants can stop background collection, revoke permissions, or leave a
  study from within the app.

See the published [privacy policy](https://liu-chao.site/StudyTrace/privacy/)
and the repository's [privacy source](docs/privacy/index.html).

## Android client

The Android client provides a modern, guided interface for:

- upfront onboarding and informed consent;
- secure study enrollment by pasted link or scanned QR code (HTTPS,
  `studytrace://`, or AWARE invitation URL);
- background location collection with a persistent notification;
- app foreground-use and screen-state research data through Android Usage
  Access;
- scheduled experience-sampling surveys and notifications;
- encrypted HTTPS uploads with an offline retry queue; and
- withdrawal, local cleanup, and an optional server deletion request.

Detailed architecture, data schemas, build instructions, signing configuration,
and device setup are in [android/README.md](android/README.md). Draft Play
Console materials are in [android/play/](android/play/).

### Build and test Android

Requirements: JDK 17 and Android SDK platform 36.

```bash
./android/gradlew -p android :app:assembleDebug
./android/gradlew -p android :app:testDebugUnitTest :app:lintDebug
./android/gradlew -p android :app:bundleRelease
```

Release signing is configured through environment variables or Gradle
properties kept outside the repository. See [android/README.md](android/README.md#signed-release-bundle).

## iPhone client

Open `StudyTrace.xcworkspace` in Xcode. The iPhone client includes equivalent
research onboarding and consent, study enrollment, surveys, sensor collection,
participant controls, and optional study-requested screenshot workflows.

Store-ready iPad screenshots and previews are documented in
[AppStoreAssets/iPad-12.9/README.md](AppStoreAssets/iPad-12.9/README.md).

## Server

The Node.js server provides study enrollment, generic sensor uploads, surveys,
researcher administration, participant withdrawal, and study configuration.
See [server/README.md](server/README.md) for configuration and deployment.

The repository root is a standalone Express app for CU Launch v1 Azure
publishing: install with `npm ci`, start with `npm start`, and use `/health`
for the health check. The root entry point boots the server in `server/`.
Existing Railway deployments can continue using either the repository root
or `server/` with their current `npm start` command.

See [Azure deployment](server/README.md#deploy-on-azure-with-cu-launch)
for PostgreSQL and environment settings before collecting data.

## Repository layout

| Path | Purpose |
| --- | --- |
| `StudyTrace/` | Native iPhone application |
| `android/` | Native Android application and Play materials |
| `server/` | StudyTrace Node.js server |
| `docs/` | Privacy, support, and marketing pages |
| `AppStoreAssets/` | Apple store screenshots and previews |

## Research deployment

Each deployment is responsible for its own ethics approval, study-specific
consent, retention policy, participant support contact, secure server
configuration, and accurate Apple/Google store disclosures. The available data
streams do not imply that every study should enable them.
