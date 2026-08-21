# dev/120 — Android APK hosting + in-CRM download link

**Status:** DONE. The debug APK is hosted in Cloudflare R2 and downloadable from a public,
same-origin API route linked on the login screen and inside the logged-in account menu.

## What shipped
1. **APK in R2.** `app/mobile/dist/techlingua-crm.apk` (~3.6 MB, `in.techlingua.crm`, WebView shell
   over the live origin — see dev/119) uploaded to the `techlingua` R2 bucket at key
   **`apk/techlingua-crm.apk`**, content-type `application/vnd.android.package-archive`. Uploaded
   with the R2 creds already stored (encrypted) in `channel_config` (storage/cloudflare), decrypted
   in memory with the api `SECRETS_KEY` — nothing hard-coded, no creds in the repo.
2. **Public download route (api/src/main.ts).** Two UNGUARDED express routes registered on the raw
   HTTP server BEFORE the SPA catch-all (and OUTSIDE the `/api` global prefix, so the SPA fallback
   never swallows them):
   - `GET /downloads/techlingua-crm.apk`
   - `GET /downloads/app.apk` (alias)
   Each streams the bytes from R2 via `StorageService.getObject('apk/techlingua-crm.apk')` and sets
   `Content-Type: application/vnd.android.package-archive`,
   `Content-Disposition: attachment; filename="techlingua-crm.apk"`, `Content-Length`, and a short
   `Cache-Control: public, max-age=300`. No auth, no DB writes. R2 creds never leave the server.
   If R2 is unconfigured it returns 503 (never a 500).
3. **In-CRM links.**
   - **Login screen** (`web/src/Login.tsx`): "⬇️ Download Android App" under the sign-in card,
     href `VITE_ANDROID_APK_URL` (default `/downloads/techlingua-crm.apk`). Hidden inside the
     Capacitor app.
   - **Account menu** (`web/src/Shell.tsx` UserMenu / Super Admin dropdown): "Download Android App"
     item (new `download` icon in `web/src/icons.tsx`), href `/downloads/techlingua-crm.apk`. Hidden
     inside the Capacitor app.

## Why an API route (not the raw R2 public URL)
Keeps the link same-origin and stable (`/downloads/…`), exposes no R2 public domain / creds, and the
server owns the content-type + attachment disposition. The R2 public object exists too
(`https://<r2_public_domain>/apk/techlingua-crm.apk`) but the app links the API route.

## Still owed (follow-up)
Signed RELEASE APK for Play-Store / general distribution (keystore + `assembleRelease`) — the hosted
artifact today is the DEBUG APK (installable via "unknown sources"). See dev/119 §"Remaining to ship
a signed RELEASE APK".
