import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ChannelConfigService, ResolvedConfig } from '../messaging/channel-config.service';
import { NotConfiguredException } from '../common/not-configured.exception';

/**
 * CLOUDFLARE R2 — THE SINGLE FILE / ASSET STORE (docs/dev/57).
 *
 * Client rule: every file/asset lives in R2 — nothing on the Railway server disk, no binary
 * blobs in the database. Only the R2 object key (+ metadata) is persisted; the bytes live in
 * the `techlingua` bucket. R2 speaks the S3 API, so we drive it with AWS SDK v3.
 *
 * CREDENTIALS come from the encrypted Settings store (`channel_config`, channel `storage`,
 * provider `cloudflare`) — the exact slot Settings already exposes: config { account_id,
 * r2_bucket, r2_public_domain } + secrets { r2_access_key_id, r2_secret_access_key }. They
 * are AES-256-GCM encrypted at rest, decrypted only in memory here, never logged. Nothing is
 * hard-coded. The S3 endpoint is derived from the account id.
 *
 * DEGRADES CLEANLY: if R2 is not configured, every operation throws NotConfiguredException
 * (a 503 naming what is missing) — never a 500, never an Error-Log row.
 *
 * KEY SCHEME:
 *   students/<sid|admission-<aid>>/docs/<uuid>-<filename>   (private — KYC / education docs)
 *   documents/<kind>/<docNo|ref>.pdf                        (private — invoices, receipts...)
 *   material/<id>/<uuid>-<filename>                         (study material files)
 * Private/sensitive objects are served via SHORT-LIVED PRESIGNED URLs, never the public base.
 * Truly public assets may use the public URL base (r2_public_domain / pub-*.r2.dev).
 */
@Injectable()
export class StorageService {
  private cachedFor: number | null = null;   // channel_config.id the cached client was built from
  private client: S3Client | null = null;
  private bucket = '';
  private publicBase = '';

  constructor(private readonly configs: ChannelConfigService) {}

  /** True when a usable R2 credential is stored — no throw. */
  async isConfigured(): Promise<boolean> {
    try { await this.resolve(); return true; } catch { return false; }
  }

  /** Resolve + (re)build the S3 client from the encrypted Settings row. Throws if not set. */
  private async resolve(): Promise<{ client: S3Client; bucket: string; publicBase: string }> {
    const cfg: ResolvedConfig | null = await this.configs.resolve('storage', null, 'cloudflare');
    const accountId = String(cfg?.config?.account_id ?? '').trim();
    const bucket = String(cfg?.config?.r2_bucket ?? '').trim();
    const accessKeyId = String(cfg?.secrets?.r2_access_key_id ?? '').trim();
    const secretAccessKey = String(cfg?.secrets?.r2_secret_access_key ?? '').trim();
    const publicBase = String(cfg?.config?.r2_public_domain ?? '').trim();
    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
      const miss = [
        !accountId && 'Account ID', !bucket && 'R2 bucket name',
        !accessKeyId && 'R2 access key ID', !secretAccessKey && 'R2 secret access key',
      ].filter(Boolean).join(', ');
      throw new NotConfiguredException(
        `Cloudflare R2 storage is not configured — missing: ${miss}. Add it in Administration › Settings › Channels.`,
      );
    }
    // Reuse the client while the underlying row is unchanged (id changes on any save).
    if (this.client && this.cachedFor === (cfg!.id ?? null) && this.bucket === bucket) {
      return { client: this.client, bucket: this.bucket, publicBase: this.publicBase };
    }
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    this.cachedFor = cfg!.id ?? null;
    this.bucket = bucket;
    this.publicBase = publicBase;
    return { client: this.client, bucket, publicBase };
  }

  /** Drop any cached client (e.g. after the credential is re-saved). */
  reset(): void { this.client = null; this.cachedFor = null; this.bucket = ''; this.publicBase = ''; }

  // ---------------------------------------------------------------- key scheme

  private safeName(raw: unknown): string {
    return String(raw ?? 'file')
      .trim().replace(/[\r\n\t]+/g, ' ').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || 'file';
  }

  /** students/<sid|admission-<aid>>/docs/<uuid>-<filename> */
  studentDocKey(opts: { studentId?: number | null; admissionId?: number | null; fileName: string }): string {
    const owner = opts.studentId ? String(opts.studentId) : `admission-${opts.admissionId ?? 'na'}`;
    return `students/${owner}/docs/${randomUUID()}-${this.safeName(opts.fileName)}`;
  }

  /** documents/<kind>/<docNo>.pdf — the generated business PDFs. */
  pdfKey(kind: string, docNo: string | number): string {
    const safeKind = this.safeName(kind).toLowerCase();
    const safeNo = this.safeName(docNo);
    return `documents/${safeKind}/${safeNo}.pdf`;
  }

  /** material/<id>/<uuid>-<filename> — study-material file uploads. */
  materialKey(materialRef: string | number, fileName: string): string {
    return `material/${this.safeName(materialRef)}/${randomUUID()}-${this.safeName(fileName)}`;
  }

  /** questions/media/<uuid>-<filename> — question / option image + audio (private, presigned). */
  questionMediaKey(fileName: string): string {
    return `questions/media/${randomUUID()}-${this.safeName(fileName)}`;
  }

  /** submissions/<uuid>-<filename> — assignment/practical file submissions (private, presigned). */
  submissionKey(fileName: string): string {
    return `submissions/${randomUUID()}-${this.safeName(fileName)}`;
  }

  // ---------------------------------------------------------------- operations

  async putObject(key: string, bytes: Buffer | Uint8Array, contentType: string): Promise<{ key: string }> {
    const { client, bucket } = await this.resolve();
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: bytes, ContentType: contentType || 'application/octet-stream',
    }));
    return { key };
  }

  async getObject(key: string): Promise<{ body: Buffer; contentType: string }> {
    const { client, bucket } = await this.resolve();
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await this.streamToBuffer(out.Body);
    return { body, contentType: String(out.ContentType ?? 'application/octet-stream') };
  }

  async headObject(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const { client, bucket } = await this.resolve();
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: Number(out.ContentLength ?? 0), contentType: String(out.ContentType ?? '') };
    } catch { return null; }
  }

  async deleteObject(key: string): Promise<void> {
    const { client, bucket } = await this.resolve();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /** Short-lived signed GET — this is how a private doc/PDF is downloaded (default 5 min). */
  async presignGet(key: string, expiresSeconds = 300, downloadName?: string): Promise<string> {
    const { client, bucket } = await this.resolve();
    const cmd = new GetObjectCommand({
      Bucket: bucket, Key: key,
      ...(downloadName ? { ResponseContentDisposition: `inline; filename="${this.safeName(downloadName)}"` } : {}),
    });
    return getSignedUrl(client, cmd, { expiresIn: Math.max(30, Math.min(expiresSeconds, 3600)) });
  }

  /** Short-lived signed PUT — for an optional direct browser -> R2 upload. */
  async presignPut(key: string, contentType: string, expiresSeconds = 300): Promise<string> {
    const { client, bucket } = await this.resolve();
    const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType || 'application/octet-stream' });
    return getSignedUrl(client, cmd, { expiresIn: Math.max(30, Math.min(expiresSeconds, 3600)) });
  }

  /** Public CDN URL for a genuinely public asset. Empty when no public domain is configured. */
  publicUrl(key: string): string {
    if (!this.publicBase) return '';
    const base = this.publicBase.replace(/\/+$/, '');
    const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    return `${withScheme}/${key.replace(/^\/+/, '')}`;
  }

  private async streamToBuffer(body: unknown): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    // Node stream
    if (typeof (body as any)[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    }
    if (typeof (body as any).transformToByteArray === 'function') {
      return Buffer.from(await (body as any).transformToByteArray());
    }
    return Buffer.from(body as any);
  }
}
