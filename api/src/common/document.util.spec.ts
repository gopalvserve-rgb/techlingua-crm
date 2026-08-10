import { parseIncomingDocuments } from './document.util';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const png = { doc_type: 'photo', file_name: 'me.png', mime: 'image/png', content: b64('hello-png') };

describe('document.util — parseIncomingDocuments (upload guard)', () => {
  it('returns [] when nothing is attached', () => {
    expect(parseIncomingDocuments(undefined)).toEqual([]);
    expect(parseIncomingDocuments(null)).toEqual([]);
  });

  it('decodes an allowed file to bytes with metadata', () => {
    const out = parseIncomingDocuments([png]);
    expect(out).toHaveLength(1);
    expect(out[0].doc_type).toBe('photo');
    expect(out[0].mime).toBe('image/png');
    expect(Buffer.isBuffer(out[0].content)).toBe(true);
    expect(out[0].content.toString()).toBe('hello-png');
    expect(out[0].size_bytes).toBe('hello-png'.length);
  });

  it('accepts a data: URL prefix and strips it', () => {
    const out = parseIncomingDocuments([{ ...png, content: `data:image/png;base64,${b64('x')}` }]);
    expect(out[0].content.toString()).toBe('x');
  });

  it('coerces an unknown doc_type to "other"', () => {
    const out = parseIncomingDocuments([{ ...png, doc_type: 'weird' }]);
    expect(out[0].doc_type).toBe('other');
  });

  it('rejects a disallowed MIME type', () => {
    expect(() => parseIncomingDocuments([{ ...png, mime: 'application/x-msdownload' }])).toThrow(/PDF, JPG or PNG/);
  });

  it('rejects a file over 5 MB', () => {
    const big = { ...png, content: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') };
    expect(() => parseIncomingDocuments([big])).toThrow(/5 MB/);
  });

  it('rejects more than 12 files', () => {
    const many = Array.from({ length: 13 }, () => png);
    expect(() => parseIncomingDocuments(many)).toThrow(/at most 12/);
  });

  it('rejects an empty file', () => {
    expect(() => parseIncomingDocuments([{ ...png, content: '' }])).toThrow(/empty/);
  });
});
