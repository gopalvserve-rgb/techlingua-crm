import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import * as express from 'express';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { config } from './config';
import { QuestionService } from './assessments/question.service';
import { StorageService } from './storage/storage.service';

async function bootstrap() {
  // bodyParser:false -> we register express.json ourselves with a bigger limit:
  // bulk CSV import posts the file as text in the body (see ingestion/import.service.ts,
  // MAX_CSV_BYTES = 5 MB). Express's 100 KB default would 413 every real import.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Keep the RAW body: Meta signs the exact bytes it sent (X-Hub-Signature-256 =
  // HMAC-SHA256 over the raw payload). Re-serialising the parsed JSON would change
  // key order/spacing and every signature would fail. Cheap: one Buffer reference.
  const keepRaw = (req: express.Request, _res: express.Response, buf: Buffer) => {
    if (buf?.length) (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  };
  app.use(express.json({ limit: '8mb', verify: keepRaw }));
  app.use(express.urlencoded({ limit: '8mb', extended: true, verify: keepRaw }));
  app.setGlobalPrefix('api');

  // CORS. The app itself is same-origin; the ONE exception is the public website-form
  // endpoint, whose allowed origins are configured PER CHANNEL in the database and so
  // cannot be known here. For those routes we let the preflight fall through
  // (`preflightContinue`) to WebhookController.formPreflight, which looks the channel
  // up and answers with that channel's own allow-list. No other route is affected.
  app.enableCors((req: express.Request, cb: (e: Error | null, o: CorsOptions) => void) => {
    if (String(req.url ?? '').startsWith('/api/webhooks/form/')) {
      cb(null, { origin: false, preflightContinue: true });
    } else {
      cb(null, { origin: config.webOrigin, credentials: true });
    }
  });

  // PUBLIC APK DOWNLOAD (docs/dev/120) — the Android app (Capacitor WebView shell) is hosted in
  // R2 at `apk/techlingua-crm.apk`. These UNGUARDED routes stream the bytes from R2 same-origin so
  // the in-CRM "Download Android App" link is a plain, stable URL with NO R2 creds exposed. They
  // live OUTSIDE the `/api` global prefix and are registered BEFORE the SPA catch-all below so the
  // SPA fallback never swallows them. No auth (public download), no DB writes.
  {
    const httpServer = app.getHttpAdapter().getInstance() as express.Express;
    const APK_KEY = 'apk/techlingua-crm.apk';
    const localApk = join(__dirname, '..', 'public', 'downloads', 'techlingua-crm.apk');
    const serveApk = async (_req: express.Request, res: express.Response) => {
      try {
        // Prefer an APK bundled with the deploy (web/public/downloads); fall back to R2.
        if (existsSync(localApk)) {
          const body = readFileSync(localApk);
          res.setHeader('Content-Type', 'application/vnd.android.package-archive');
          res.setHeader('Content-Disposition', 'attachment; filename="techlingua-crm.apk"');
          res.setHeader('Content-Length', String(body.length));
          res.setHeader('Cache-Control', 'public, max-age=60');
          res.status(200).end(body);
          return;
        }
        const storage = app.get(StorageService, { strict: false });
        const { body } = await storage.getObject(APK_KEY);
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Disposition', 'attachment; filename="techlingua-crm.apk"');
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).end(body);
      } catch (e) {
        res
          .status(503)
          .json({ statusCode: 503, message: 'Android app is not available for download yet.' });
      }
    };
    httpServer.get('/downloads/techlingua-crm.apk', serveApk);
    httpServer.get('/downloads/app.apk', serveApk);
  }

  // Single-URL deployment: serve the built React app from api/public when present.
  // No-op in local dev (public/ absent) — the web app runs on Vite with its own proxy.
  const publicDir = join(__dirname, '..', 'public');
  const indexHtml = join(publicDir, 'index.html');
  if (existsSync(indexHtml)) {
    const server = app.getHttpAdapter().getInstance() as express.Express;
    // Hashed build assets: long-lived cache. index.html itself is never served here (index: false).
    server.use(
      express.static(publicDir, {
        index: false,
        maxAge: '1y',
        immutable: true,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    // SPA fallback: any GET outside /api/* returns index.html (no-cache) so deep links work.
    server.get(/^\/(?!api(\/|$)).*/, (_req: express.Request, res: express.Response) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  await app.listen(config.port);
  // eslint-disable-next-line no-console
  console.log(`Tech Lingua CRM API listening on :${config.port}`);

  // Self-healing DEMO MEDIA seed (docs/dev/64). Migration 067 points the demo image_mcq/audio_mcq
  // at fixed R2 keys; this ensures the actual bytes exist in R2 (a real PNG + WAV synthesised in
  // Node, uploaded via StorageService — the same store Batch A uses). Idempotent (uploads only
  // when the object is missing) and error-swallowed: if R2 is not configured it is simply skipped,
  // never crashing boot. Runs in the server process only (not in tests, which never call main).
  try {
    await app.get(QuestionService, { strict: false }).seedDemoMedia();
    // eslint-disable-next-line no-console
    console.log('[boot] demo assessment media ensured in R2');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[boot] demo assessment media seed skipped:', (e as Error)?.message ?? e);
  }
}
bootstrap();
