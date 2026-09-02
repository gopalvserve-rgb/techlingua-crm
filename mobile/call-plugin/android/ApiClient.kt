package com.techlingua.crm.calls

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** Thin authenticated POST helper for the background workers. Base URL + JWT come from prefs. */
object ApiClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS).build()
    private val JSON = "application/json; charset=utf-8".toMediaType()

    fun creds(ctx: Context): Pair<String, String> {
        val sp = ctx.getSharedPreferences("crm_prefs", 0)
        return (sp.getString("api_base", "") ?: "") to (sp.getString("jwt", "") ?: "")
    }

    /** POST json to `path` (e.g. "/api/calls/log-sync"). Returns response body, or null on failure. */
    fun postJson(ctx: Context, path: String, json: String): String? {
        val (base, token) = creds(ctx)
        if (base.isEmpty() || token.isEmpty()) return null
        val req = Request.Builder()
            .url(base.trimEnd('/') + path)
            .addHeader("Authorization", "Bearer $token")
            .post(json.toRequestBody(JSON))
            .build()
        return runCatching { http.newCall(req).execute().use { if (it.isSuccessful) it.body?.string() else null } }
            .getOrNull()
    }
}
