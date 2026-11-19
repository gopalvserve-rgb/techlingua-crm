/**
 * QR CODE + CODE 39 — dependency-free (client 12 Nov 2026: "QR verification" and "QR code /
 * barcode" on certificates, ID cards and marksheets).
 *
 * QR: ISO/IEC 18004 byte mode, error-correction level M (15% recovery), versions 1–10 (up to
 * 213 bytes — a verification URL is ~60), automatic mask choice by the standard penalty rules.
 * The algorithm follows the well-known reference structure (function patterns → codewords with
 * Reed–Solomon ECC, interleaved → zig-zag placement → mask → format/version bits). Pinned by
 * qr.spec.ts against published reference values (RS codewords, format and version bits).
 *
 * Returns a square boolean matrix (true = dark); the renderer draws one rect per dark module,
 * with the 4-module quiet zone left to the caller.
 */

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** GF(256) multiply, primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D). */
export function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r: number[] = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

/** The Reed–Solomon error-correction codewords for one block. */
export function rsRemainder(data: number[], degree: number): number[] {
  const div = rsDivisor(degree);
  const r: number[] = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (r.shift() as number);
    r.push(0);
    for (let i = 0; i < degree; i++) r[i] ^= gfMul(div[i], factor);
  }
  return r;
}

/** 15-bit format information for ECC level M (bits 00) and a mask 0–7. */
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information (versions 7+). */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** Data codewords (with ECC, interleaved) for `bytes` at `version`, ECC level M. */
export function codewords(bytes: number[], version: number): number[] {
  const total = TOTAL_CODEWORDS[version];
  const eccLen = ECC_PER_BLOCK_M[version];
  const numBlocks = BLOCKS_M[version];
  const dataCap = total - eccLen * numBlocks;
  // bit stream: mode 0100 (byte), count (8 bits for v1–9, 16 for v10), data, terminator, pad
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = dataCap * 8;
  if (bits.length > capBits) throw new Error('QR data too long');
  push(0, Math.min(4, capBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);
  // split into blocks, ECC each, interleave
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len); k += len;
    const ecc = rsRemainder(dat, eccLen);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortLen - eccLen || j >= numShort) out.push(blocks[j][i]);
    }
  }
  return out;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  let version = 1;
  for (; version <= 10; version++) {
    const cap = TOTAL_CODEWORDS[version] - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];
    const header = 4 + (version < 10 ? 8 : 16);
    if (header + bytes.length * 8 <= cap * 8) break;
  }
  if (version > 10) throw new Error('QR data too long (max 213 bytes)');
  const size = version * 4 + 17;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { mod[y][x] = dark; fn[y][x] = true; };

  // timing patterns
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finder patterns (+ separators)
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // alignment patterns
  const pos = ALIGN[version]; const n = pos.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const b = formatBits(mask);
    for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
    set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3); const b2 = Math.floor(i / 3);
      set(a, b2, bit(vb, i)); set(b2, a, bit(vb, i));
    }
  }
  // data
  const cw = codewords(bytes, version);
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && k < cw.length * 8) { mod[y][x] = bit(cw[k >>> 3], 7 - (k & 7)); k++; }
      }
    }
  }
  // masks: try all eight, keep the lowest penalty
  const cond = (m: number, x: number, y: number) => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && cond(m, x, y)) mod[y][x] = !mod[y][x];
  };
  let best = 0; let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const s = penalty(mod);
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);   // undo (XOR)
  }
  applyMask(best); drawFormat(best);
  return mod;
}

/** Standard mask penalty (N1 runs, N2 2×2 blocks, N3 finder-like patterns, N4 dark balance). */
function penalty(m: boolean[][]): number {
  const size = m.length; let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(m[y]);
  for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]));
  const pat1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pat2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (const ln of lines) {
    let run = 1;
    for (let i = 1; i <= ln.length; i++) {
      if (i < ln.length && ln[i] === ln[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    for (let i = 0; i + 11 <= ln.length; i++) {
      if (pat1.every((v, j) => ln[i + j] === v) || pat2.every((v, j) => ln[i + j] === v)) score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/* ------------------------------------------------------------------ Code 39 */

/** 9 elements per character (bar, space, bar, …), 1 = wide. Exactly three are wide. */
export const CODE39: Record<string, string> = {
  '0': '000110100', '1': '100100001', '2': '001100001', '3': '101100000', '4': '000110001', '5': '100110000',
  '6': '001110000', '7': '000100101', '8': '100100100', '9': '001100100', A: '100001001', B: '001001001',
  C: '101001000', D: '000011001', E: '100011000', F: '001011000', G: '000001101', H: '100001100',
  I: '001001100', J: '000011100', K: '100000011', L: '001000011', M: '101000010', N: '000010011',
  O: '100010010', P: '001010010', Q: '000000111', R: '100000110', S: '001000110', T: '000010110',
  U: '110000001', V: '011000001', W: '111000000', X: '010010001', Y: '110010000', Z: '011010000',
  '-': '010000101', '.': '110000100', ' ': '011000100', '*': '010010100', $: '010101000', '/': '010100010',
  '+': '010001010', '%': '000101010',
};

/** Code 39 bars as [x, width] in narrow-module units (wide = 3, gap between characters = 1). */
export function code39Bars(text: string): { bars: Array<[number, number]>; width: number } {
  const clean = String(text ?? '').toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '-');
  const chars = `*${clean}*`;
  const bars: Array<[number, number]> = [];
  let x = 0;
  for (const ch of chars) {
    const p = CODE39[ch];
    for (let i = 0; i < 9; i++) {
      const w = p[i] === '1' ? 3 : 1;
      if (i % 2 === 0) bars.push([x, w]);
      x += w;
    }
    x += 1;   // inter-character gap
  }
  return { bars, width: x - 1 };
}
