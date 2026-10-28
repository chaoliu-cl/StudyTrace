package edu.studytrace.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadPolicyTest {
    @Test
    fun offlineScreenshotBacklogIsSplitByBytesAndPreservesOrder() {
        val rows = listOf("image-a-123456", "image-b-123456", "image-c-123456", "survey")
        val batches = UploadPolicy.batchLines(rows, maxRows = 500, maxBytes = 22)
        assertEquals(3, batches.size)
        assertEquals(rows, batches.flatten())
        assertTrue(batches.all { batch -> batch.sumOf { it.toByteArray().size + 1 } <= 22 })
    }

    @Test
    fun uploadBatchesRespectRowLimitAndUtf8Bytes() {
        assertEquals(listOf(listOf("a", "b"), listOf("c")), UploadPolicy.batchLines(listOf("a", "b", "c"), 2))
        assertEquals(2, UploadPolicy.batchLines(listOf("日本語", "日本語"), 500, 12).size)
        assertTrue(UploadPolicy.batchLines(emptyList(), 500).isEmpty())
    }
}
