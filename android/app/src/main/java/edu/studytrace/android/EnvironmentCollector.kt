package edu.studytrace.android

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import org.json.JSONObject
import java.util.UUID

/** Real lux readings are separate from the server's modeled outdoor sunlight. */
class EnvironmentCollector(private val context: Context) : SensorEventListener {
    private val manager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val settings get() = context.getSharedPreferences("studytrace_environment", Context.MODE_PRIVATE)
    private var lastSample = 0L
    private var missingReported = false

    fun start() {
        manager.unregisterListener(this)
        val prefs = StudyPrefs(context)
        if (!prefs.consentGranted || !prefs.enrollmentConfirmed || !prefs.locationTrackingEnabled || !settings.getBoolean("enabled", false)) return
        val light = manager.getDefaultSensor(Sensor.TYPE_LIGHT)
        if (light == null) {
            if (missingReported) return
            missingReported = true
            Thread { UploadQueue.enqueue(context, "environment_measures", Telemetry.zoneFields(JSONObject(), System.currentTimeMillis())
                .put("timestamp", System.currentTimeMillis()).put("event_id", UUID.randomUUID().toString())
                .put("source", "android_ambient_light").put("measurement_type", "device_sensor")
                .put("light_lux", JSONObject.NULL).put("light_lux_status", "sensor_unavailable")) }.start()
        } else manager.registerListener(this, light, SensorManager.SENSOR_DELAY_NORMAL)
    }

    fun stop() { manager.unregisterListener(this) }

    override fun onSensorChanged(event: SensorEvent) {
        val prefs = StudyPrefs(context)
        if (!settings.getBoolean("enabled", false) || !prefs.consentGranted || !prefs.locationTrackingEnabled) { stop(); return }
        val now = System.currentTimeMillis()
        val lux = event.values.firstOrNull() ?: return
        if (!lux.isFinite() || lux < 0 || now - lastSample < 15 * 60 * 1000) return
        lastSample = now
        val accuracy = event.accuracy
        Thread { UploadQueue.enqueue(context, "environment_measures", Telemetry.zoneFields(JSONObject(), now)
            .put("timestamp", now).put("event_id", UUID.randomUUID().toString())
            .put("source", "android_ambient_light").put("measurement_type", "device_sensor")
            .put("light_lux", lux.toDouble()).put("light_lux_status", "measured").put("sensor_accuracy", accuracy)) }.start()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    companion object {
        fun refreshSettings(context: Context) {
            val study = StudyApi(context).currentContext() ?: return
            val enabled = StudyApi(context).fetchEnvironmentConfig()?.optBoolean("enabled") ?: return
            // Do not restore settings after withdrawal or a study switch.
            if (!StudyPrefs(context).consentGranted || StudyApi(context).currentContext() != study) return
            context.getSharedPreferences("studytrace_environment", Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply()
        }
        fun clear(context: Context) { context.getSharedPreferences("studytrace_environment", Context.MODE_PRIVATE).edit().clear().apply() }
    }
}
