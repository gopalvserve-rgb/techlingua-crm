package com.techlingua.crm.calls

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject

/**
 * Every 15 min: scan the user-granted SAF recording folder for NEW audio files and upload each
 * (base64) to /api/calls/recording-upload. The server stores it in R2, matches a lead by phone
 * and links it to the nearest call. The app never records audio itself — it reads the files the
 * OEM dialer already wrote. Manufacturers name files differently, so the phone number is parsed
 * from the file name where present and the server also links by time window as a fallback.
 */
class RecordingSyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        val sp = applicationContext.getSharedPreferences("crm_prefs", 0)
        val tree = sp.getString("rec_tree_uri", "") ?: ""
        if (tree.isEmpty()) return Result.success()   // folder not picked yet — nothing to do
        val lastMtime = sp.getLong("rec_cursor", 0L)
        var maxSeen = lastMtime

        val dir = DocumentFile.fromTreeUri(applicationContext, Uri.parse(tree)) ?: return Result.success()
        val audio = Regex("\\.(m4a|mp3|amr|3gp|wav|aac|ogg)$", RegexOption.IGNORE_CASE)

        // recurse one level (most dialers keep a flat folder; some nest by date)
        fun files(d: DocumentFile): List<DocumentFile> =
            d.listFiles().flatMap { if (it.isDirectory) files(it) else listOf(it) }

        for (f in files(dir)) {
            val name = f.name ?: continue
            if (!audio.containsMatchIn(name)) continue
            val mtime = f.lastModified()
            if (mtime <= lastMtime) continue
            if (mtime > maxSeen) maxSeen = mtime
            if (f.length() > 25L * 1024 * 1024) continue   // server rejects > 25MB

            val bytes = runCatching {
                applicationContext.contentResolver.openInputStream(f.uri)?.use { it.readBytes() }
            }.getOrNull() ?: continue

            // most OEM dialers embed the number in the file name, e.g. "Call_919876543210_...".
            val phone = Regex("(\\+?\\d[\\d\\-\\s]{6,}\\d)").find(name)?.value?.filter { it.isDigit() } ?: ""

            val body = JSONObject().apply {
                put("phone", phone)
                put("file_name", name)
                put("mime", guessMime(name))
                put("file_mtime", java.time.Instant.ofEpochMilli(mtime).toString())
                put("source_hash", "${f.uri}:$mtime")
                put("content_base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            }.toString()

            val ok = ApiClient.postJson(applicationContext, "/api/calls/recording-upload", body)
            if (ok == null) return Result.retry()   // network down — try the whole batch again later
        }
        sp.edit().putLong("rec_cursor", maxSeen).apply()
        return Result.success()
    }

    private fun guessMime(name: String) = when (name.substringAfterLast('.').lowercase()) {
        "mp3" -> "audio/mpeg"; "amr" -> "audio/amr"; "wav" -> "audio/wav"
        "3gp" -> "audio/3gpp"; "aac" -> "audio/aac"; "ogg" -> "audio/ogg"; else -> "audio/mp4"
    }
}
