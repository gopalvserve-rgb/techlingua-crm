import { deflateSync } from 'zlib';

/**
 * DEMO MEDIA — Assessment remediation (docs/dev/64).
 *
 * The Batch-A demo `image_mcq` / `audio_mcq` questions shipped with NULL media keys, so the
 * question sheet showed "—" instead of a real image / audio player. This module synthesises two
 * tiny, REAL assets (a labelled binary-tree PNG and a short listening-clip WAV) entirely in Node —
 * no external files, deterministic bytes — which the one-shot `POST /questions/seed-demo-media`
 * endpoint uploads to Cloudflare R2 (via StorageService, the SAME path Batch A uses) under these
 * fixed keys. Migration 067 backfills the question rows with the SAME keys, so the two agree.
 *
 * Fixed (non-random) keys are used on purpose so the migration and the upload target the exact
 * same object — unlike the browser upload flow which mints a random questionMediaKey per file.
 */

export const DEMO_IMAGE_MCQ_KEY = 'questions/media/demo/binary-tree-diagram.png';
export const DEMO_AUDIO_MCQ_KEY = 'questions/media/demo/listening-clip-their.wav';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/**
 * A small (260x170) 24-bit RGB PNG drawing a labelled binary tree — a plausible answer to the demo
 * question "Identify the data structure shown in the diagram." (correct option: Binary tree).
 */
export function demoBinaryTreePng(): Buffer {
  const W = 260, H = 170;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < px.length; i += 3) { px[i] = 245; px[i + 1] = 247; px[i + 2] = 250; } // light bg
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  const line = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      set(x, y, r, g, b); set(x + 1, y, r, g, b);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  };
  const disc = (cx: number, cy: number, rad: number, r: number, g: number, b: number) => {
    for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) if (x * x + y * y <= rad * rad) set(cx + x, cy + y, r, g, b);
  };
  const nodes: Array<[number, number]> = [[130, 35], [70, 95], [190, 95], [40, 150], [100, 150]];
  line(130, 35, 70, 95, 90, 110, 130); line(130, 35, 190, 95, 90, 110, 130);
  line(70, 95, 40, 150, 90, 110, 130); line(70, 95, 100, 150, 90, 110, 130);
  for (const [x, y] of nodes) { disc(x, y, 16, 20, 120, 140); disc(x, y, 13, 224, 247, 250); }
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const idat = deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit, colour-type 2 (RGB)
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A ~0.6s 440 Hz sine tone as 8 kHz mono 16-bit PCM WAV — a tiny, real, playable listening clip. */
export function demoListeningClipWav(): Buffer {
  const sr = 8000, n = Math.floor(sr * 0.6);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 400, (n - i) / 400);       // short fade in/out to avoid clicks
    const s = Math.sin((2 * Math.PI * 440 * i) / sr) * 0.5 * env;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
