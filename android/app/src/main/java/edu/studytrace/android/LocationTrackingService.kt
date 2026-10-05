package edu.studytrace.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.IBinder
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.UUID

class LocationTrackingService : Service(), LocationListener {
    private lateinit var locationManager: LocationManager

    override fun onCreate() {
        super.onCreate()
        NotificationHelper.ensureChannels(this)
        startForeground(
            NotificationHelper.LOCATION_NOTIFICATION_ID,
            NotificationHelper.locationNotification(this),
        )
        locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = StudyPrefs(this)
        if (!prefs.consentGranted || !prefs.enrollmentConfirmed || !hasLocationPermission()) {
            stopSelf()
            return START_NOT_STICKY
        }
        requestUpdates(LocationManager.GPS_PROVIDER)
        requestUpdates(LocationManager.NETWORK_PROVIDER)
        uploadDeviceState("location_service_started")
        return START_STICKY
    }

    override fun onDestroy() {
        runCatching { locationManager.removeUpdates(this) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onLocationChanged(location: Location) {
        val now = System.currentTimeMillis()
        // Fix time, unless the provider's clock is clearly wrong (e.g. GPS week rollover).
        val fixTime = location.time.takeIf { it > 0 && kotlin.math.abs(now - it) < MAX_CLOCK_SKEW_MILLIS } ?: now
        // Rows are buffered in the persistent queue; SyncWorker uploads them in batches.
        val row = Telemetry.zoneFields(JSONObject(), fixTime)
            .put("timestamp", fixTime)
            .put("event_id", UUID.randomUUID().toString())
            .put("received_at", now)
            .put("double_latitude", location.latitude)
            .put("double_longitude", location.longitude)
            .put("double_altitude", location.altitude)
            .put("double_bearing", location.bearing.toDouble())
            .put("double_speed", location.speed.toDouble())
            .put("double_accuracy", location.accuracy.toDouble())
            .put("provider", location.provider ?: "")
            .put("elapsed_realtime_nanos", location.elapsedRealtimeNanos)
        Thread {
            UploadQueue.enqueue(this, LOCATIONS_SENSOR, row)
        }.start()
    }

    @Deprecated("Deprecated in Android framework; retained for API compatibility.")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    override fun onProviderEnabled(provider: String) = Unit
    override fun onProviderDisabled(provider: String) = Unit

    @SuppressLint("MissingPermission")
    private fun requestUpdates(provider: String) {
        if (!hasLocationPermission()) return
        if (!locationManager.isProviderEnabled(provider)) return
        try {
            locationManager.requestLocationUpdates(provider, 180_000L, 50f, this)
            // A cached fix is only useful if recent; stale ones would misplace the participant.
            locationManager.getLastKnownLocation(provider)
                ?.takeIf { System.currentTimeMillis() - it.time <= MAX_LAST_KNOWN_AGE_MILLIS }
                ?.let(::onLocationChanged)
        } catch (_: SecurityException) {
            // A runtime permission can be revoked between the check and the framework call.
            stopSelf()
        }
    }

    private fun hasLocationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun uploadDeviceState(reason: String) {
        Thread {
            Telemetry.recordDeviceState(this, reason)
        }.start()
    }

    companion object {
        const val LOCATIONS_SENSOR = "locations"
        private const val MAX_LAST_KNOWN_AGE_MILLIS = 10L * 60L * 1000L
        private const val MAX_CLOCK_SKEW_MILLIS = 24L * 60L * 60L * 1000L
    }
}
