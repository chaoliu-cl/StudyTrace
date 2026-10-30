# Environmental collection in StudyTrace

For complete Railway deployment, study setup, phone permissions, testing,
exports, troubleshooting, and rollback, follow
[the complete pilot deployment guide](RAILWAY_PILOT_DEPLOYMENT.md).

## Features and opt-ins

In the researcher dashboard, set **Environment measures** to **On**, select the
features included in the study, and click **Save environment collection**:

- Weather: temperature, humidity, apparent temperature, wind speed,
  precipitation, cloud cover, weather code, and solar radiation.
- Local-date daylight: sunrise, sunset, and day length, with the phone/study zone.
- **Include air pollution**: six pollutant concentrations in µg/m³ and separate
  US/European AQI indices from Open-Meteo/CAMS.
- **Add five environment context questions**: current setting, perceived noise,
  temperature sensation, outdoor time, and green-space contact. These attach to
  ordinary questionnaires without extra notifications. Original instrument
  wording/order/choices remain intact. The items are optional and study-specific.
- **Include GPS-based green-space map context**: 300 m land-cover percentages
  from ESA WorldCover 2021 v200. GPS accuracy must be reported and 100 m or better;
  missing/poor accuracy and incomplete maps are flagged rather than set to zero.

Context and map options are off until explicitly enabled. The master control
must be on for these options to take effect. Changing this form preserves all
stored survey/screenshot schedules. The special three-instrument/one-photo pilot
schedule still uses its separate setup helper; avoid resaving the dashboard's
single-schedule ESM form afterward.

## Exports and interpretation

`environment_measures` CSV/ZIP rows use separate sources:

| Source | Data / sampling |
| --- | --- |
| `open_meteo` | Outdoor weather, at most one/device/UTC hour after GPS upload |
| `open_meteo_daylight` | First eligible location per device/local date/time zone |
| `open_meteo_air_quality` | CAMS outdoor air estimates, at most one/device/UTC hour |
| `esa_worldcover` | Historical map context, at most one usable result/device/15-minute period |

Context responses appear in `survey_responses`, with versioned
`studytrace_context_*_v1` item identifiers. Perceived noise is not a decibel
measurement. Time bands are not exact minutes. Keep these items separate from
validated instrument scores.

WorldCover represents the **2021 reference year**, not current imagery or an
observed park visit. The natural-vegetation measure includes classes 10, 20, 30,
90, 95, and 100; crops, buildings, and water are separate. Percentages are based
on valid classified area, requiring at least 90% map coverage. GPS accuracy and
rounding error remain in exports. See the full guide/codebook for field meanings.

Personal light and indoor exposure sensing are off for this protocol. Existing
Android clients must **Refresh surveys** to fetch the light-off setting. Older
queued/historical light rows remain identifiable as `android_ambient_light`.
Outdoor solar radiation and astronomical daylight are not personal light doses.

All provider lookups are driven by recent GPS uploads; offline phones and
provider failures leave gaps. Sources retry independently, preserving GPS.
No API key, cron job, global raster download, or extra GIS service is required.
These server additions use existing phone GPS/radio-question support. Earlier
mobile upload and photo fixes still need the updated signed apps.

Include provider processing and new survey/map measures in participant
information/consent. Records preserve attribution to Open-Meteo, CAMS, and ESA.

- [Weather API](https://open-meteo.com/en/docs)
- [Air-quality API and attribution](https://open-meteo.com/en/docs/air-quality-api)
- [ESA WorldCover data and reference year](https://esa-worldcover.org/en/data-access)
