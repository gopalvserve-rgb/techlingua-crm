package com.techlingua.crm.calls

import android.content.Intent
import android.net.Uri
import androidx.work.*
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.TimeUnit

/**
 * Call-Tracking native bridge. Exposes tap-to-dial + schedules the two WorkManager sync jobs.
 * The heavy lifting (reading CallLog / scanning the SAF folder / uploading) lives in the two
 * Workers so it survives Doze and WebView death — this class only wires the UI to them.
 */
@CapacitorPlugin(name = "CallPlugin")
class CallPlugin : Plugin() {

    /** Persist api base + JWT for the background workers (called after web login). */
    @PluginMethod
    fun configure(call: PluginCall) {
        val sp = context.getSharedPreferences("crm_prefs", 0)
        sp.edit()
            .putString("api_base", call.getString("apiBase") ?: "")
            .putString("jwt", call.getString("token") ?: "")
            .apply()
        call.resolve()
    }

    /** Open the phone dialer for `number`. On Android the app cannot silently place a call as a
     *  3rd-party app; ACTION_DIAL pre-fills the dialer and the rep taps call (needs no permission). */
    @PluginMethod
    fun dial(call: PluginCall) {
        val number = call.getString("number").orEmpty().filter { it.isDigit() || it == '+' }
        if (number.isEmpty()) { call.reject("number required"); return }
        val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number"))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    /** Persist the SAF tree URI the user picks (opened from JS via the standard file picker or here). */
    @PluginMethod
    fun setRecordingFolder(call: PluginCall) {
        val uri = call.getString("treeUri").orEmpty()
        context.getSharedPreferences("crm_prefs", 0).edit().putString("rec_tree_uri", uri).apply()
        // take persistable permission so the worker can read it later
        runCatching {
            context.contentResolver.takePersistableUriPermission(
                Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        call.resolve()
    }

    /** Schedule (or reschedule) the periodic sync jobs. Intervals in minutes (min 15 per Android). */
    @PluginMethod
    fun startWorkers(call: PluginCall) {
        val logMin = (call.getInt("logSyncMinutes") ?: 60).coerceAtLeast(15).toLong()
        val recMin = (call.getInt("recSyncMinutes") ?: 15).coerceAtLeast(15).toLong()
        val net = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        val logReq = PeriodicWorkRequestBuilder<CallLogSyncWorker>(logMin, TimeUnit.MINUTES)
            .setConstraints(net).build()
        val recReq = PeriodicWorkRequestBuilder<RecordingSyncWorker>(recMin, TimeUnit.MINUTES)
            .setConstraints(net).build()

        WorkManager.getInstance(context).apply {
            enqueueUniquePeriodicWork("call_log_sync", ExistingPeriodicWorkPolicy.UPDATE, logReq)
            enqueueUniquePeriodicWork("recording_sync", ExistingPeriodicWorkPolicy.UPDATE, recReq)
        }
        call.resolve()
    }

    /** Run both syncs once, now (used by a manual "Sync now" button). */
    @PluginMethod
    fun syncNow(call: PluginCall) {
        val wm = WorkManager.getInstance(context)
        wm.enqueue(OneTimeWorkRequestBuilder<CallLogSyncWorker>().build())
        wm.enqueue(OneTimeWorkRequestBuilder<RecordingSyncWorker>().build())
        call.resolve()
    }

    @PluginMethod
    fun stopWorkers(call: PluginCall) {
        WorkManager.getInstance(context).apply {
            cancelUniqueWork("call_log_sync"); cancelUniqueWork("recording_sync")
        }
        call.resolve()
    }
}
