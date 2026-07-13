import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  // bodyParser:false -> we register express.json ourselves with a bigger limit:
  // bulk CSV import posts the file as text in the body (see ingestion/import.service.ts,
  // MAX_CSV_BYTES = 5 MB). Express's 100 KB default would 413 every real import.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ limit: '8mb', extended: true }));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: config.webOrigin, credentials: true });

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
}
bootstrap();
