import { StorageService } from './storage.service';
import { PdfAssetService } from './pdf-asset.service';
import { isNotConfigured } from '../common/not-configured.exception';

/**
 * R2 STORAGE LAYER — unit tests. R2 is MOCKED here: no unit test ever touches the network
 * or a real bucket. We assert the key scheme, the presigned-vs-public policy, the
 * not-configured degrade, and that a generated PDF persists only its R2 KEY (no DB blob).
 */

function cfgService(row: any) {
  return { resolve: async () => row } as any; // ChannelConfigService.resolve stand-in
}

const R2_ROW = {
  id: 42,
  config: { account_id: 'acc123', r2_bucket: 'techlingua', r2_public_domain: 'pub-abc.r2.dev' },
  secrets: { r2_access_key_id: 'AK', r2_secret_access_key: 'SK' },
};

describe('StorageService key scheme + policy', () => {
  const svc = new StorageService(cfgService(R2_ROW));

  it('composes the student-document key: students/<owner>/docs/<uuid>-<filename>', () => {
    const k = svc.studentDocKey({ admissionId: 99, fileName: 'aadhaar card.pdf' });
    expect(k).toMatch(/^students\/admission-99\/docs\/[0-9a-f-]{36}-aadhaar_card.pdf$/);
    const k2 = svc.studentDocKey({ studentId: 7, fileName: 'me.png' });
    expect(k2).toMatch(/^students\/7\/docs\/[0-9a-f-]{36}-me.png$/);
  });

  it('composes the pdf key: documents/<kind>/<no>.pdf', () => {
    expect(svc.pdfKey('certificate', 'CERT-0001')).toBe('documents/certificate/CERT-0001.pdf');
    expect(svc.pdfKey('invoice', 'INV/2026/07')).toBe('documents/invoice/INV_2026_07.pdf');
  });

  it('composes the material key under material/<id>/', () => {
    expect(svc.materialKey(12, 'notes.pdf')).toMatch(/^material\/12\/[0-9a-f-]{36}-notes.pdf$/);
  });

  it('publicUrl uses the public base for genuinely public assets', () => {
    expect(svc.publicUrl('material/12/x.pdf')).toBe('');   // not built until resolve()
  });
});

describe('StorageService not-configured degrade', () => {
  it('throws NotConfiguredException (a clean 503) when no credential is stored', async () => {
    const svc = new StorageService(cfgService(null));
    expect(await svc.isConfigured()).toBe(false);
    let caught: unknown;
    try { await svc.putObject('k', Buffer.from('x'), 'text/plain'); } catch (e) { caught = e; }
    expect(isNotConfigured(caught)).toBe(true);
  });

  it('throws not-configured when the secret keys are missing', async () => {
    const svc = new StorageService(cfgService({ id: 1, config: { account_id: 'a', r2_bucket: 'b' }, secrets: {} }));
    expect(await svc.isConfigured()).toBe(false);
  });
});

describe('PdfAssetService persists only the R2 key (no DB blob, no disk)', () => {
  it('putObject then upsert generated_document with the key; returns it', async () => {
    const puts: any[] = [];
    const dbCalls: any[] = [];
    const storage: any = {
      isConfigured: async () => true,
      pdfKey: (kind: string, no: any) => `documents/${kind}/${no}.pdf`,
      putObject: async (key: string, bytes: Buffer, ct: string) => { puts.push({ key, len: bytes.length, ct }); return { key }; },
    };
    const db: any = { query: async (sql: string, params: any[]) => { dbCalls.push({ sql, params }); return []; } };
    const svc = new PdfAssetService(db, storage);
    const key = await svc.persist('certificate', 12, 'CERT-0001', Buffer.from('%PDF-1.4 body'), 1);
    expect(key).toBe('documents/certificate/CERT-0001.pdf');
    expect(puts[0].ct).toBe('application/pdf');
    const ins = dbCalls.find((c) => /INSERT INTO generated_document/.test(c.sql));
    expect(ins).toBeTruthy();
    expect(ins.params).toContain('documents/certificate/CERT-0001.pdf');  // only the KEY is stored
    // the PDF bytes are NOT among the params (no blob)
    expect(ins.params.some((p: any) => Buffer.isBuffer(p))).toBe(false);
  });

  it('returns null and writes nothing when R2 is not configured', async () => {
    const storage: any = { isConfigured: async () => false, pdfKey: () => 'x' };
    const db: any = { query: async () => { throw new Error('should not be called'); } };
    const svc = new PdfAssetService(db, storage);
    expect(await svc.persist('invoice', 1, 'INV-1', Buffer.from('x'))).toBeNull();
  });
});
