import { BadRequestException } from '@nestjs/common';

/**
 * DOCUMENT ATTACHMENTS — shared parse + guard for the admission / student document uploads.
 *
 * The public admission form (and any future authenticated uploader) sends documents inline in
 * the JSON body as { doc_type, file_name, mime, content } where `content` is base64 (optionally
 * a data: URL). We decode to bytes here and enforce a strict allow-list + size/count caps BEFORE
 * anything touches the DB, so a hostile payload can never store an executable, an oversized blob,
 * or an unbounded number of files. The raw bytes are returned as a Buffer for BYTEA storage and
 * are NEVER logged.
 */
export const DOC_TYPES = ['photo', 'aadhaar', 'pan', 'qualification', 'other'] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** Allowed MIME types — common ID / education document formats only. */
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per file
const MAX_FILES = 12;                // a handful of docs per applicant

export interface ParsedDocument {
  doc_type: DocType;
  file_name: string;
  mime: string;
  size_bytes: number;
  content: Buffer;
}

function sanitizeName(raw: unknown, mime: string): string {
  let name = String(raw ?? '').trim().replace(/[\r\n\t]+/g, ' ').replace(/[/\\]+/g, '_');
  name = name.slice(0, 200);
  if (!name) {
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    name = `document.${ext}`;
  }
  return name;
}

/** Decode + validate an inbound documents array. Returns [] when none supplied. Throws 400 on abuse. */
export function parseIncomingDocuments(raw: unknown): ParsedDocument[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('Documents must be a list.');
  if (raw.length > MAX_FILES) throw new BadRequestException(`Please attach at most ${MAX_FILES} files.`);

  const out: ParsedDocument[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const mimeRaw = String((item as any).mime ?? '').toLowerCase().trim();
    const mime = mimeRaw === 'image/jpg' ? 'image/jpeg' : mimeRaw;
    if (!ALLOWED_MIME.has(mimeRaw)) {
      throw new BadRequestException('Only PDF, JPG or PNG files are allowed.');
    }
    const dtRaw = String((item as any).doc_type ?? 'other').toLowerCase().trim();
    const doc_type = (DOC_TYPES as readonly string[]).includes(dtRaw) ? (dtRaw as DocType) : 'other';

    // content: base64, possibly a data: URL ("data:image/png;base64,AAAA...").
    let b64 = String((item as any).content ?? '');
    const comma = b64.indexOf(',');
    if (b64.startsWith('data:') && comma >= 0) b64 = b64.slice(comma + 1);
    b64 = b64.replace(/\s+/g, '');
    if (!b64) throw new BadRequestException('An attached file was empty.');

    let content: Buffer;
    try { content = Buffer.from(b64, 'base64'); }
    catch { throw new BadRequestException('An attached file could not be read.'); }
    if (!content.length) throw new BadRequestException('An attached file was empty.');
    if (content.length > MAX_BYTES) throw new BadRequestException('Each file must be 5 MB or smaller.');

    out.push({ doc_type, file_name: sanitizeName((item as any).file_name, mime), mime, size_bytes: content.length, content });
  }
  return out;
}
