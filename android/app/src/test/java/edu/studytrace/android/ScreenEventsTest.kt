package edu.studytrace.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScreenEventsTest {
    @Test
    fun mapsUsageEventTypes() {
        assertEquals("screen_on", ScreenEvents.eventName(15))
        assertEquals("screen_off", ScreenEvents.eventName(16))
        assertEquals("lock", ScreenEvents.eventName(17))
        assertEquals("unlock", ScreenEvents.eventName(18))
        assertNull(ScreenEvents.eventName(UsageAggregator.ACTIVITY_RESUMED))
        assertNull(ScreenEvents.eventName(UsageAggregator.ACTIVITY_PAUSED))
    }

    @Test
    fun keepsOnlyNewScreenEventsInOrder() {
        val events = listOf(
            UsageEventRecord(3_000, UsageAggregator.KEYGUARD_HIDDEN, "android"),
            UsageEventRecord(1_000, UsageAggregator.SCREEN_INTERACTIVE, "android"),
            UsageEventRecord(2_000, UsageAggregator.ACTIVITY_RESUMED, "com.a"),
            UsageEventRecord(500, UsageAggregator.SCREEN_NON_INTERACTIVE, "android"),
            UsageEventRecord(4_000, UsageAggregator.KEYGUARD_SHOWN, "android"),
            UsageEventRecord(4_000, UsageAggregator.KEYGUARD_SHOWN, "android"),
        )
        val result = ScreenEvents.fromUsageEvents(events, afterMillis = 500)
        assertEquals(
            listOf(
                ScreenEvent(1_000, "screen_on"),
                ScreenEvent(3_000, "unlock"),
                ScreenEvent(4_000, "lock"),
            ),
            result,
        )
        assertEquals("screen:3000:unlock", result[1].dedupeKey)
    }

    @Test
    fun classifiesUploadResponses() {
        assertEquals(UploadOutcome.SUCCESS, UploadPolicy.classify(201))
        assertEquals(UploadOutcome.RETRY, UploadPolicy.classify(UploadPolicy.NETWORK_ERROR))
        assertEquals(UploadOutcome.RETRY, UploadPolicy.classify(408))
        assertEquals(UploadOutcome.RETRY, UploadPolicy.classify(429))
        assertEquals(UploadOutcome.RETRY, UploadPolicy.classify(503))
        assertEquals(UploadOutcome.DROP, UploadPolicy.classify(400))
        assertEquals(UploadOutcome.DROP, UploadPolicy.classify(403))
    }
}
