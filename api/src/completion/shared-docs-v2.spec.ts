import { SharedDocsService } from './shared-docs.service';

/** Client 12 Nov 2026 — Shared Documents: sub-folders, versions, edit rights. */
function mk(opts: { doc?: any; admin?: boolean; loop?: boolean } = {}) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  const one = jest.fn(async (sql: string, p: unknown[] = []) => {
    calls.push({ sql, p });
    if (/FROM shared_doc WHERE id = \$1/.test(sql)) return opts.doc ?? null;
    if (/FROM shared_doc_folder WHERE id = \$1/.test(sql)) return { id: 1, name: 'A', parent_id: null };
    if (/WITH RECURSIVE t AS/.test(sql)) return opts.loop ? { x: 1 } : null;
    if (/shared_doc\.delete/.test(sql)) return opts.admin ? { '?column?': 1 } : null;
    return null;
  });
  const tx = jest.fn(async (fn: any) => fn({ query: async (sql: string, p: unknown[]) => { calls.push({ sql, p }); return { rows: [] }; } }));
  const db: any = { one, query: jest.fn(async (sql: string, p: unknown[] = []) => { calls.push({ sql, p }); return []; }), tx };
  const storage: any = { isConfigured: async () => false };
  return { svc: new SharedDocsService(db, storage), calls };
}
const file = { name: 'v2.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4 new').toString('base64') };

describe('shared documents v2', () => {
  it('a folder cannot be moved inside itself or its own sub-folder', async () => {
    await expect(mk({ loop: true }).svc.renameFolder(1, { parent_id: 2 })).rejects.toThrow(/inside itself/);
  });

  it('a new version keeps the old file as a numbered version and bumps the number', async () => {
    const { svc, calls } = mk({ doc: { id: 7, org_id: 1, uploaded_by: 5, version_no: 2, file_name: 'v1.pdf', mime: 'application/pdf', size_bytes: 10, content: Buffer.from('old'), created_at: '2026-11-01' } });
    const out = await svc.newVersion(7, { file, note: 'new fees' }, 5);
    expect(out.version_no).toBe(3);
    const ins = calls.find((c) => /INSERT INTO shared_doc_version/.test(c.sql))!;
    expect(ins.p.slice(0, 3)).toEqual([7, 2, 'v1.pdf']);
    const upd = calls.find((c) => /UPDATE shared_doc SET file_name/.test(c.sql))!;
    expect(upd.p[1]).toBe('v2.pdf');
  });

  it('only the uploader or an admin may change a document', async () => {
    const { svc } = mk({ doc: { id: 7, uploaded_by: 5 }, admin: false });
    await expect(svc.newVersion(7, { file }, 9)).rejects.toThrow(/uploaded it/);
    await expect(svc.update(7, { title: 'x' }, 9)).rejects.toThrow(/uploaded it/);
  });
});
