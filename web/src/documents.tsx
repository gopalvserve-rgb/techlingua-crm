/**
 * DOCUMENT ATTACHMENTS — shared client helpers + the uploaded-documents list.
 *
 * Used by the public admission form (upload), the admission review screen (list + download)
 * and the student profile ID & Documents tab (list + download). Kept in its OWN module so
 * both admissions.tsx and dyn.tsx can import it without a circular dependency.
 */
import { useRef, useState } from 'react';
import { Ic } from './icons';
import { getToken, api } from './api';
import { toast, useFetch } from './refdata';

/* --------- education + KYC: client-side guard + helpers -------- */
export const DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png';
export const DOC_MAX_BYTES = 5 * 1024 * 1024;
export const DOC_MAX_FILES = 12;
const DOC_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);
export const DOC_LABELS: Record<string, string> = { photo: 'Photo', aadhaar: 'Aadhaar', pan: 'PAN', qualification: 'Qualification', other: 'Other document' };
export const SINGLE_DOCS: Array<[string, string]> = [
  ['photo', 'Passport photo'], ['aadhaar', 'Aadhaar card'], ['pan', 'PAN card'],
  ['qualification', 'Highest qualification marksheet / certificate'],
];
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Reject anything but PDF/JPG/PNG under 5 MB — a clear message, checked before upload. */
export function docError(f: File): string | null {
  const mime = (f.type || '').toLowerCase();
  const okExt = /\.(pdf|jpe?g|png)$/i.test(f.name);
  if (mime && !DOC_MIME.has(mime)) return `"${f.name}" is not a PDF, JPG or PNG.`;
  if (!mime && !okExt) return `"${f.name}" is not a PDF, JPG or PNG.`;
  if (f.size > DOC_MAX_BYTES) return `"${f.name}" is ${(f.size / 1048576).toFixed(1)} MB — the limit is 5 MB.`;
  return null;
}

/** Read a file as a base64 data URL and shape it for the JSON submit payload. */
export function fileToDoc(f: File, doc_type: string): Promise<any> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ doc_type, file_name: f.name, mime: f.type || 'application/octet-stream', size: f.size, content: String(r.result ?? '') });
    r.onerror = () => rej(new Error('Could not read the file'));
    r.readAsDataURL(f);
  });
}

/** Authenticated document download — the bytes come back as an attachment, not JSON. */
export async function authedDownload(path: string, fallbackName: string) {
  try {
    const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) { toast('Download failed', true); return; }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename="?([^"]+)"?/.exec(cd)?.[1] ?? fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch { toast('Download failed', true); }
}

/**
 * Open a document via a short-lived PRESIGNED Cloudflare R2 URL when the file is stored in R2
 * (the client's single-file-store rule — docs/dev/57). Sensitive KYC/education docs are NEVER
 * public: the URL is signed, expires in 5 minutes, and is fetched behind the authed request.
 * Falls back to the direct authenticated byte-download for any legacy (pre-R2) row.
 */
export async function openDocument(basePath: string, doc: { id: number; file_name: string; in_r2?: boolean }) {
  if (doc.in_r2) {
    try {
      const urlPath = `${basePath}/documents/${doc.id}/url`;
      const res = await fetch(`/api${urlPath}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (res.ok) {
        const body = await res.json();
        if (body?.url) { window.open(body.url, '_blank', 'noopener'); return; }
      }
    } catch { /* fall through to the direct download */ }
  }
  await authedDownload(`${basePath}/documents/${doc.id}/download`, doc.file_name);
}

/** The uploaded-documents list on the review screen + student profile (download each). */
export function DocumentList({ basePath }: { basePath: string }) {
  const { data } = useFetch<any[]>(`${basePath}/documents`, [basePath]);
  const docs = data ?? [];
  if (docs.length === 0) return <div className="empty-note">No documents uploaded.</div>;
  return (
    <>
      {docs.map((doc: any) => (
        <div className="lrow" key={doc.id}>
          <div className="gr" style={{ minWidth: 0 }}>
            <div className="t1"><b>{DOC_LABELS[doc.doc_type] ?? doc.doc_type}</b> <span className="sub">· {doc.file_name}</span></div>
            <div className="t2 sub">{fmtSize(Number(doc.size_bytes ?? 0))} · {doc.mime}</div>
          </div>
          <button className="btn sm" data-testid={`doc-dl-${doc.id}`} onClick={() => openDocument(basePath, doc)}><Ic k="doc" />Download</button>
        </div>
      ))}
    </>
  );
}


/* ============================================================================
 * STUDENT PROFILE — upload + manage documents, and change the profile photo.
 * All assets go straight to Cloudflare R2 via a presigned PUT; the row stores only the
 * r2_key (never a DB blob). Delete is by PK and also purges the R2 object.
 * ==========================================================================*/

/** Presign, PUT the file to R2, and return the stored r2_key. */
async function uploadToR2(base: string, file: File): Promise<{ r2_key: string; file: File }> {
  const { url, r2_key } = await api.post<{ url: string; r2_key: string }>(`${base}/upload-url`, {
    file_name: file.name, content_type: file.type || 'application/octet-stream',
  });
  const res = await fetch(url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error('Upload to storage failed');
  return { r2_key, file };
}

const UPLOAD_TYPES: Array<[string, string]> = [
  ['aadhaar', 'Aadhaar'], ['pan', 'PAN'], ['qualification', 'Qualification / marksheet'],
  ['address_proof', 'Address proof'], ['kyc', 'KYC'], ['education', 'Education'], ['other', 'Other document'],
];

/** The student profile ID & Documents manager: upload (KYC/education/misc) + list + download + delete. */
export function StudentDocuments({ studentId, canManage }: { studentId: number; canManage: boolean }) {
  const base = `/students/${studentId}`;
  const { data, reload } = useFetch<any[]>(`${base}/documents`, [studentId]);
  const docs = (data ?? []).filter((d: any) => d.doc_type !== 'photo'); // the photo is the avatar, not a listed doc
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState('aadhaar');
  const [busy, setBusy] = useState(false);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    const err = docError(f); if (err) { toast(err, true); return; }
    setBusy(true);
    try {
      const { r2_key } = await uploadToR2(`${base}/documents`, f);
      await api.post(`${base}/documents`, { r2_key, file_name: f.name, mime: f.type || 'application/octet-stream', size_bytes: f.size, doc_type: docType });
      toast('Document uploaded'); reload();
    } catch (ex) { toast((ex as Error).message || 'Upload failed', true); } finally { setBusy(false); }
  };
  const del = async (doc: any) => {
    if (!window.confirm(`Delete "${doc.file_name}"? This cannot be undone.`)) return;
    try { await api.del(`${base}/documents/${doc.id}`); toast('Document deleted'); reload(); }
    catch (ex) { toast((ex as Error).message || 'Delete failed', true); }
  };

  return (
    <>
      {canManage && (
        <div className="lrow" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="inp sm" value={docType} onChange={(e) => setDocType(e.target.value)} data-testid="stu-doc-type" style={{ maxWidth: 220 }}>
            {UPLOAD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input ref={fileRef} type="file" accept={DOC_ACCEPT} style={{ display: 'none' }} onChange={onPick} data-testid="stu-doc-file" />
          <button className="btn primary sm" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="stu-doc-upload">
            <Ic k="export" />{busy ? 'Uploading…' : 'Upload document'}
          </button>
          <span className="sub" style={{ fontSize: 11 }}>PDF, JPG or PNG · up to 5 MB</span>
        </div>
      )}
      {docs.length === 0 ? <div className="empty-note">No documents uploaded.</div> : docs.map((doc: any) => (
        <div className="lrow" key={doc.id}>
          <div className="gr" style={{ minWidth: 0 }}>
            <div className="t1"><b>{DOC_LABELS[doc.doc_type] ?? doc.doc_type}</b> <span className="sub">· {doc.file_name}</span></div>
            <div className="t2 sub">{fmtSizePub(Number(doc.size_bytes ?? 0))} · {doc.mime}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" data-testid={`doc-dl-${doc.id}`} onClick={() => openDocument(base, doc)}><Ic k="doc" />Download</button>
            {canManage && <button className="btn sm danger" data-testid={`doc-del-${doc.id}`} onClick={() => del(doc)}><Ic k="trash" />Delete</button>}
          </div>
        </div>
      ))}
    </>
  );
}

/** Change the student profile photo: presigned image upload to R2, then attach. Calls onDone
 *  (reload the profile) so the header avatar reflects the new photo. */
export function StudentPhotoUpload({ studentId, onDone, className }: { studentId: number; onDone: () => void; className?: string }) {
  const base = `/students/${studentId}`;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const IMG_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    if (f.type && !IMG_MIME.has(f.type.toLowerCase())) { toast('Choose a JPG, PNG or WEBP image.', true); return; }
    if (f.size > 5 * 1024 * 1024) { toast('The photo must be under 5 MB.', true); return; }
    setBusy(true);
    try {
      const { r2_key } = await uploadToR2(`${base}/photo`, f);
      await api.post(`${base}/photo`, { r2_key, file_name: f.name, mime: f.type || 'image/jpeg', size_bytes: f.size });
      toast('Photo updated'); onDone();
    } catch (ex) { toast((ex as Error).message || 'Upload failed', true); } finally { setBusy(false); }
  };
  return (
    <>
      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPick} data-testid="stu-photo-file" />
      <button type="button" className={className ?? 'fbp-photo-edit'} title="Change photo" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="stu-photo-upload">
        <Ic k="pencil" />{busy ? '…' : ''}
      </button>
    </>
  );
}

/** dev/88 — Vertical LOGO uploader (image → Cloudflare R2, presigned PUT, live preview).
 *  Mirrors the student-photo flow: request a presigned url, PUT the bytes, then attach the
 *  r2_key. The vertical row stores only logo_r2_key; the parent re-reads to get logo_url. */
export function VerticalLogoUpload({ verticalId, initialUrl, onDone }: { verticalId: number; initialUrl?: string | null; onDone?: (logoUrl: string | null) => void }) {
  const base = `/verticals/${verticalId}/logo`;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(initialUrl ?? null);
  const IMG_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml']);
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    if (f.type && !IMG_MIME.has(f.type.toLowerCase())) { toast('Choose a JPG, PNG, WEBP or SVG image.', true); return; }
    if (f.size > 5 * 1024 * 1024) { toast('The logo must be under 5 MB.', true); return; }
    setBusy(true);
    try {
      const { r2_key } = await uploadToR2(base, f);
      const out = await api.post<{ logo_url: string | null }>(base, { r2_key, content_type: f.type || 'image/png' });
      setUrl(out.logo_url ?? null);
      toast('Logo updated'); onDone?.(out.logo_url ?? null);
    } catch (ex) { toast((ex as Error).message || 'Upload failed', true); } finally { setBusy(false); }
  };
  return (
    <div className="lrow" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ width: 64, height: 64, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--panel2, #f4f5f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }} data-testid="vert-logo-preview">
        {url ? <img src={url} alt="Vertical logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <Ic k="grid" />}
      </div>
      <div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPick} data-testid="vert-logo-file" />
        <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="vert-logo-upload">
          <Ic k="export" />{busy ? 'Uploading…' : (url ? 'Change logo' : 'Upload logo')}
        </button>
        <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>JPG, PNG, WEBP or SVG · up to 5 MB · shown on this vertical’s invoices</div>
      </div>
    </div>
  );
}

const fmtSizePub = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/* ---- dev/132 ITEM B — vertical MULTIPLE bank accounts + UPI id + payment QR ---- */

export type VertBank = { name: string; account_no: string; ifsc: string; branch: string; account_holder: string; active: boolean };
export type VertPayments = { banks: VertBank[]; upi_id: string };

const emptyBank = (active = false): VertBank => ({ name: '', account_no: '', ifsc: '', branch: '', account_holder: '', active });

/** Controlled editor: add-more bank rows with a "Required/active" radio, plus a UPI id field.
 *  Calls onChange with the current value on every edit so the parent can submit it. */
export function VerticalBanksEditor({ initial, onChange }: { initial?: VertPayments; onChange: (v: VertPayments) => void }) {
  const [banks, setBanks] = useState<VertBank[]>(() => {
    const b = (initial?.banks ?? []).map((x) => ({ ...emptyBank(), ...x, active: !!x.active }));
    return b.length ? b : [emptyBank(true)];
  });
  const [upi, setUpi] = useState<string>(initial?.upi_id ?? '');
  const emit = (nb: VertBank[], nu: string) => onChange({ banks: nb, upi_id: nu });
  const setRow = (i: number, patch: Partial<VertBank>) => {
    setBanks((xs) => { const nx = xs.map((b, j) => (j === i ? { ...b, ...patch } : b)); emit(nx, upi); return nx; });
  };
  const setActive = (i: number) => {
    setBanks((xs) => { const nx = xs.map((b, j) => ({ ...b, active: j === i })); emit(nx, upi); return nx; });
  };
  const addRow = () => setBanks((xs) => { const nx = [...xs, emptyBank(xs.length === 0)]; emit(nx, upi); return nx; });
  const delRow = (i: number) => setBanks((xs) => {
    let nx = xs.filter((_, j) => j !== i);
    if (nx.length && !nx.some((b) => b.active)) nx = nx.map((b, j) => ({ ...b, active: j === 0 }));
    emit(nx, upi); return nx;
  });
  const setUpiV = (v: string) => { setUpi(v); emit(banks, v); };

  return (
    <div className="fld span2" data-testid="vert-banks-editor">
      <label>Bank Accounts <span className="fhint">tick the ONE required / active bank for this vertical</span></label>
      {banks.map((b, i) => (
        <div key={i} className="bankrow" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              <input type="radio" name="vert-active-bank" checked={!!b.active} onChange={() => setActive(i)} data-testid={`vert-bank-active-${i}`} />
              Required / active
            </label>
            <span style={{ marginLeft: 'auto' }} />
            <button type="button" className="ax2" title="Remove bank" onClick={() => delRow(i)} data-testid={`vert-bank-del-${i}`}><Ic k="trash" /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            <input className="ainp" placeholder="Bank name" value={b.name} onChange={(e) => setRow(i, { name: e.target.value })} data-testid={`vert-bank-name-${i}`} />
            <input className="ainp" placeholder="Account no." value={b.account_no} onChange={(e) => setRow(i, { account_no: e.target.value })} />
            <input className="ainp" placeholder="IFSC" value={b.ifsc} onChange={(e) => setRow(i, { ifsc: e.target.value.toUpperCase() })} />
            <input className="ainp" placeholder="Bank branch" value={b.branch} onChange={(e) => setRow(i, { branch: e.target.value })} />
            <input className="ainp" placeholder="Account holder name" value={b.account_holder} onChange={(e) => setRow(i, { account_holder: e.target.value })} />
          </div>
        </div>
      ))}
      <button type="button" className="setcond" onClick={addRow} data-testid="vert-bank-add"><Ic k="plus" />Add bank account</button>
      <div style={{ marginTop: 12 }}>
        <label>UPI ID <span className="fhint">VPA for QR / UPI collections — e.g. techlingua@hdfcbank</span></label>
        <input className="ainp" placeholder="name@bank" value={upi} onChange={(e) => setUpiV(e.target.value)} data-testid="vert-upi-id" />
      </div>
    </div>
  );
}

/** QR image uploader (R2, presigned) — mirrors VerticalLogoUpload; needs the vertical id. */
export function VerticalQrUpload({ verticalId, initialUrl, onDone }: { verticalId: number; initialUrl?: string | null; onDone?: (qrUrl: string | null) => void }) {
  const base = `/verticals/${verticalId}/qr`;
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(initialUrl ?? null);
  const IMG_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml']);
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    if (f.type && !IMG_MIME.has(f.type.toLowerCase())) { toast('Choose a JPG, PNG, WEBP or SVG image.', true); return; }
    if (f.size > 5 * 1024 * 1024) { toast('The QR must be under 5 MB.', true); return; }
    setBusy(true);
    try {
      const { r2_key } = await uploadToR2(base, f);
      const out = await api.post<{ qr_url: string | null }>(base, { r2_key, content_type: f.type || 'image/png' });
      setUrl(out.qr_url ?? null);
      toast('Payment QR updated'); onDone?.(out.qr_url ?? null);
    } catch (ex) { toast((ex as Error).message || 'Upload failed', true); } finally { setBusy(false); }
  };
  return (
    <div className="lrow" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ width: 64, height: 64, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--panel2, #f4f5f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }} data-testid="vert-qr-preview">
        {url ? <img src={url} alt="Payment QR" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <Ic k="grid" />}
      </div>
      <div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPick} data-testid="vert-qr-file" />
        <button type="button" className="btn sm" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="vert-qr-upload">
          <Ic k="export" />{busy ? 'Uploading…' : (url ? 'Change QR' : 'Upload QR')}
        </button>
        <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>UPI / payment QR · JPG, PNG, WEBP or SVG · up to 5 MB</div>
      </div>
    </div>
  );
}
