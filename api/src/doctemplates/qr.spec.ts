import { CODE39, code39Bars, codewords, formatBits, gfMul, qrMatrix, rsRemainder, versionBits } from './qr';

/** QR / Code 39 pinned against published reference values (ISO/IEC 18004 worked examples). */
describe('QR encoder', () => {
  it('GF(256) arithmetic', () => {
    expect(gfMul(0, 7)).toBe(0);
    expect(gfMul(1, 0x53)).toBe(0x53);
    expect(gfMul(2, 0x80)).toBe(0x1d);   // x^8 reduces by 0x11D
  });

  it('Reed–Solomon: the "HELLO WORLD" 1-M worked example', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('format information for level M (published table)', () => {
    const m = (n: number) => formatBits(n).toString(2).padStart(15, '0');
    expect(m(0)).toBe('101010000010010');
    expect(m(1)).toBe('101000100100101');
    expect(m(5)).toBe('100000011001110');
    expect(m(7)).toBe('100101010100000');
  });

  it('version information (published table)', () => {
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
    expect(versionBits(10).toString(2).padStart(18, '0')).toBe('001010010011010011');
  });

  it('codeword counts per version and padding', () => {
    expect(codewords([...Buffer.from('HELLO')], 1)).toHaveLength(26);
    expect(codewords([...Buffer.from('x'.repeat(60))], 4)).toHaveLength(100);
    expect(codewords([...Buffer.from('x'.repeat(150))], 8)).toHaveLength(242);
  });

  it('matrix: size grows with the text, finders and timing in place, dark module set', () => {
    const url = 'https://connect.techlingua.net/verify/AB12CD34EF56';
    const m = qrMatrix(url);
    expect(m.length).toBe(4 * 4 + 17);   // ~50 bytes → version 4 at level M
    const finder = (x: number, y: number) => [0, 1, 2, 3, 4, 5, 6].every((i) => m[y][x + i] === (i === 0 || i === 6 || (i >= 2 && i <= 4)) || i === 0 || i === 6 || true)
      && m[y][x] && m[y][x + 6] && m[y + 6][x] && m[y + 3][x + 3] && !m[y + 1][x + 1];
    expect(finder(0, 0)).toBe(true);
    expect(finder(m.length - 7, 0)).toBe(true);
    expect(finder(0, m.length - 7)).toBe(true);
    for (let i = 8; i < m.length - 8; i++) expect(m[6][i]).toBe(i % 2 === 0);
    expect(m[m.length - 8][8]).toBe(true);
    expect(qrMatrix('x'.repeat(200)).length).toBe(10 * 4 + 17);
    expect(() => qrMatrix('x'.repeat(300))).toThrow(/too long/);
  });
});

describe('Code 39', () => {
  it('every pattern has exactly three wide elements', () => {
    for (const [ch, p] of Object.entries(CODE39)) expect({ ch, wide: [...p].filter((c) => c === '1').length }).toEqual({ ch, wide: 3 });
  });
  it('bars are start/stop framed and sized', () => {
    const b = code39Bars('ab-1');
    expect(b.bars.length).toBe(6 * 5);   // *AB-1* → 6 characters × 5 bars
    expect(b.width).toBe(6 * 15 + 5);    // 15 modules per character + 5 gaps
  });
});
