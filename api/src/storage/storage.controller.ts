import { BadRequestException, Controller, Headers, PayloadTooLargeException, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { StorageService } from './storage.service';

/** The largest file the relay takes — the same as the web server's own limit (nginx 100 MB). */
export const RELAY_MAX_BYTES = 100 * 1024 * 1024;

/** The raw request body. Sent as application/octet-stream, so no JSON/form parser has read it. */
export function readRawBody(req: Request, max = RELAY_MAX_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new PayloadTooLargeException(`The file is too large (${Math.round(max / 1048576)} MB at most).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * POST /storage/relay — a browser upload to a presigned storage link, made from the server
 * (22 Nov 2026: the R2 bucket refuses browser uploads, see StorageService.relayPut).
 *
 *   header  X-Upload-Url  the presigned PUT link an upload-url route returned
 *   query   ct            the file's content type (the one the link was signed for)
 *   body    the file's bytes, Content-Type application/octet-stream
 *
 * Signed-in users only (the global JWT guard). Which file may be written where was already
 * decided by the permission-checked route that signed the link.
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Post('relay')
  async relay(@Req() req: Request, @Headers('x-upload-url') url: string | undefined, @Query('ct') ct: string | undefined) {
    if (!url) throw new BadRequestException('No upload link was sent.');
    const bytes = await readRawBody(req);
    await this.storage.relayPut(url, bytes, String(ct ?? '').slice(0, 120) || 'application/octet-stream');
    return { ok: true, size: bytes.length };
  }
}
