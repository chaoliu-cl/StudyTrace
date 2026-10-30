# Weather and air pollution on Railway

StudyTrace can attach outdoor weather and air-pollution model estimates to GPS
uploads from iPhone and Android. This is backend processing: once the backend
update is deployed, phones already uploading GPS do not need a new build for
air-quality lookup. Updated mobile builds are still needed for the earlier
collection and photo fixes.

## Enable collection

1. Keep the existing Railway project, production environment, StudyTrace
   service, and Postgres database. Deploy the backend commit containing
   `fetchAirQuality` in `server/src/environment.js`. No new database migration,
   API-key variable, or Railway cron job is needed for this public API integration.
2. Open your StudyTrace `/researcher/` dashboard. Enter the study ID and its
   **researcher password**.
3. Under **Environment collection**, set **Environment measures** to **On**.
4. Check **Include air pollution (Open-Meteo/CAMS)**, then click
   **Save environment collection**. Reload and confirm both controls remain on.
   Weather and air pollution have separate opt-ins; turning on weather alone
   leaves air pollution off. The Environment measures setting is the master
   control and must remain on for either provider lookup.
5. Repeat for each study you intend to collect, including a separate test study.
   Existing studies are not automatically opted into air pollution by deployment.
   Saving environment settings preserves survey and screenshot schedules.
6. Ensure consented phones have location access and upload fresh GPS fixes.
   On iPhone, allow background location and reopen/upload online. On Android,
   tap **Refresh surveys**, confirm **Start collection**, and use **Upload now**
   during testing. The Android refresh also updates optional light collection.

The researcher-only API accepts:

```http
PUT /api/v1/studies/YOUR_STUDY_ID/environment-settings
x-researcher-password: YOUR_RESEARCHER_PASSWORD
Content-Type: application/json

{"enabled":true,"air_quality_enabled":true}
```

Participant passwords cannot change these settings. Older clients that omit
`air_quality_enabled` preserve its existing setting. Unchecking the air-pollution
box stops future air lookups while weather continues. Switching Environment
measures Off stops both lookups; existing records remain stored. GPS collection
itself is controlled separately on phones.

## What is collected

Both sources appear as separate rows in the **`environment_measures`** CSV under
**Sensor coverage**, and in the full study ZIP. The underlying PostgreSQL table
is `aware_environment_measures`; it is created on demand. CSV columns may be
blank when they belong to a different source.

| Source | Fields | Units |
| --- | --- | --- |
| `open_meteo` | `temperature_c`, `cloud_cover_percent`, `weather_code`, `shortwave_radiation_w_m2` | °C, %, WMO code, W/m² |
| `open_meteo_air_quality` | `pm2_5_ug_m3`, `pm10_ug_m3`, `carbon_monoxide_ug_m3`, `nitrogen_dioxide_ug_m3`, `sulphur_dioxide_ug_m3`, `ozone_ug_m3` | µg/m³ for all six pollutants |
| `open_meteo_air_quality` | `us_aqi`, `european_aqi` | Dimensionless provider indices, on different scales |
| `android_ambient_light` | `light_lux`, `light_lux_status` | Phone sensor lux, when available |

Air-quality rows identify the model as CAMS via Open-Meteo and include
`air_quality_observed_at`, `location_timestamp`, `fetched_at`, rounded request
coordinates, returned model grid coordinates, and provider attribution. Timestamp
fields use epoch milliseconds; `air_quality_observed_at` represents a UTC hour.
The CSV codebook explains each column.

US AQI uses pollutant-specific averaging periods and differs from European AQI.
Keep the raw concentrations and the two indices as separate variables. An AQI
value is not a pollutant concentration. Missing/invalid provider values stay
missing, while valid zeros remain zero. Historical rows collected before this
feature will not contain air-pollution fields.

## Sampling and interpretation

The server uses the newest eligible location in an incoming batch, rounded to
0.01 degrees before sending coordinates to Open-Meteo. Each source stores at most
one observation per device and UTC hour. Air quality can start in an hour that
already has a weather row. Provider requests run independently: an air-quality
outage does not block weather or reject the phone's original GPS upload. A later
location upload retries the missing source.

This is upload-driven, rather than a timer that runs without phone data. Offline
phones and gaps in GPS leave gaps in environmental observations. Only newly
uploaded recent fixes (within roughly 48 hours) are considered. Enabling a setting
does not scan/backfill old stored GPS rows or every hour of an uploaded batch.
Survey notification times do not limit environmental collection to those times.

These are **outdoor area model estimates**, with different spatial and temporal
resolution from a person's movements. Open-Meteo selects European/global CAMS
coverage automatically. Its documented European resolution is approximately
11 km and global resolution approximately 45 km; global native model output is
three-hourly, so hourly API output can interpolate between model times. Rounding
request coordinates to 0.01 degrees does not improve the underlying model
resolution. Use these as contextual exposures with appropriate spatial/temporal
limitations, rather than indoor or personal pollution measurements. Solar
radiation is not phone illuminance in lux. iPhone lux remains missing.

Describe the weather and air-quality provider lookups in the study's participant
information/consent. Data exports retain attribution to Open-Meteo and the CAMS
ENSEMBLE providers / Copernicus Atmosphere Monitoring Service.

## Verify one iPhone and one Android

1. Use a separate consented test study. Turn on Environment measures and the
   air-pollution checkbox, then upload a fresh valid GPS fix from each phone.
2. Download `locations` and confirm each device actually uploaded recent
   coordinates. Enrollment counts or `/health` do not prove collection.
3. Download `environment_measures`. For each device, find
   `source=open_meteo_air_quality`, with `measurement_type=outdoor_model_estimate`.
   Check the pollutant/AQI columns and the observation/location timestamps.
   Find the corresponding `source=open_meteo` weather row separately.
4. Check hourly observations after subsequent GPS uploads. Do not add repeated
   concentration/AQI readings or confuse Android light-only rows with weather
   or air-quality records. The full ZIP includes the CSV and its codebook.
5. If GPS arrives but air data do not, confirm both study controls are on, the
   backend deployment includes this update, and the GPS timestamp/coordinates
   are valid. Inspect Railway's StudyTrace deployment logs for
   `[environment] Air quality enrichment deferred:`. Provider failures preserve
   GPS uploads and retry on subsequent location uploads.

API units, model coverage, AQI definitions, and required attribution are described
in the [Open-Meteo Air Quality API documentation](https://open-meteo.com/en/docs/air-quality-api).
Weather variables follow the [weather API documentation](https://open-meteo.com/en/docs).
Provider documentation checked October 30, 2026.
