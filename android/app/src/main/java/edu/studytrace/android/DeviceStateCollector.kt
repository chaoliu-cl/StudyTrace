package edu.studytrace.android

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

object DeviceStateCollector {
    /** Permission fields compared between snapshots to emit permission_changed. */
    val PERMISSION_KEYS = listOf(
        "notification_authorization",
        "location_authorization",
        "location_accuracy_authorization",
        "usage_access",
    )

    /** Device-state fields; Telemetry adds timestamp, event_id, seq and time zone. */
    fun row(context: Context, reason: String): JSONObject {
        val prefs = StudyPrefs(context)
        val battery = context.getSystemService(BatteryManager::class.java)
        val power = context.getSystemService(PowerManager::class.java)
        val notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val notificationPolicy = context.getSystemService(NotificationManager::class.java)
            .currentInterruptionFilter.toString()
        val capacity = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return JSONObject()
            .put("reason", reason)
            .put("device_id", prefs.deviceId)
            .put("device_name", prefs.deviceName)
            .put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            .put("system_name", "Android")
            .put("system_version", Build.VERSION.RELEASE)
            .put("sdk_int", Build.VERSION.SDK_INT)
            .put("battery_level", if (capacity in 0..100) capacity / 100.0 else JSONObject.NULL)
            .put("battery_charging", battery.isCharging)
            .put("low_power_mode_enabled", power.isPowerSaveMode)
            .put("notification_authorization", if (notificationsEnabled) "authorized" else "denied")
            .put("notification_policy", notificationPolicy)
            .put("location_authorization", locationAuthorization(context))
            .put("location_accuracy_authorization", locationAccuracy(context))
            .put("usage_access", if (UsageStatsCollector.hasUsageAccess(context)) "granted" else "denied")
            .put("location_tracking_enabled", prefs.locationTrackingEnabled)
    }

    private fun locationAuthorization(context: Context): String {
        val fine = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)
        val background = if (Build.VERSION.SDK_INT >= 29) {
            granted(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        } else {
            fine || coarse
        }
        return when {
            (fine || coarse) && background -> "authorized_always"
            fine || coarse -> "authorized_when_in_use"
            else -> "denied"
        }
    }

    /** Mirrors iOS accuracy authorization: precise ("full") vs approximate ("reduced"). */
    private fun locationAccuracy(context: Context): String =
        when {
            granted(context, Manifest.permission.ACCESS_FINE_LOCATION) -> "full"
            granted(context, Manifest.permission.ACCESS_COARSE_LOCATION) -> "reduced"
            else -> "none"
        }

    private fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
}
