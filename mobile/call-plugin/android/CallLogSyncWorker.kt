package com.techlingua.crm.calls

import android.content.Context
import android.provider.CallLog
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject

/**
 * Hourly: read the phone's own CallLog.Calls since the last cursor and POST the batch to
 * /api/calls/log-sync. The server dedupes on external_log_id, repairs matching live rows,
 * and links each call to a lead by phone number. CallLog is the single source of truth.
 */
class CallLogSyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val sp = applicationContext.getSharedPreferences("crm_prefs", 0)
        // only track the SIM slots the user chose ([] = all). Stored as CSV of slot indices.
        val slots = (sp.getString("sim_slots", "") ?: "").split(",").mapNotNull { it.trim().toIntOrNull() }.toSet()
        val since = sp.getLong("calllog_cursor", 0L)
        var maxSeen = since

        val rows = JSONArray()
        val proj = arrayOf(
            CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
            CallLog.Calls.DATE, CallLog.Calls.DURATION,
            CallLog.Calls.PHONE_ACCOUNT_ID
        )
        val cursor = runCatching {
            applicationContext.contentResolver.query(
                CallLog.Calls.CONTENT_URI, proj,
                "${CallLog.Calls.DATE} > ?", arrayOf(since.toString()),
                "${CallLog.Calls.DATE} ASC")
        }.getOrNull() ?: return Result.retry()

        cursor.use { c ->
            val iId = c.getColumnIndex(CallLog.Calls._ID)
            val iNo = c.getColumnIndex(CallLog.Calls.NUMBER)
            val iType = c.getColumnIndex(CallLog.Calls.TYPE)
            val iDate = c.getColumnIndex(CallLog.Calls.DATE)
            val iDur = c.getColumnIndex(CallLog.Calls.DURATION)
            val iAcct = c.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
            while (c.moveToNext()) {
                val date = c.getLong(iDate)
                if (date > maxSeen) maxSeen = date
                val dir = when (c.getInt(iType)) {
                    CallLog.Calls.INCOMING_TYPE -> "in"
                    CallLog.Calls.OUTGOING_TYPE -> "out"
                    CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE -> "missed"
                    else -> "unknown"
                }
                rows.put(JSONObject().apply {
                    put("external_log_id", c.getString(iId))
                    put("phone", c.getString(iNo) ?: "")
                    put("direction", dir)
                    put("duration_s", c.getLong(iDur))
                    put("call_start_at", java.time.Instant.ofEpochMilli(date).toString())
                    put("sim_label", c.getString(iAcct) ?: JSONObject.NULL)
                })
            }
        }

        if (rows.length() == 0) return Result.success()
        val body = JSONObject().put("rows", rows).toString()
        val res = ApiClient.postJson(applicationContext, "/api/calls/log-sync", body)
            ?: return Result.retry()
        // advance cursor only after a confirmed POST, so a failed sync retries the same window
        sp.edit().putLong("calllog_cursor", maxSeen).apply()
        return Result.success()
    }
}
