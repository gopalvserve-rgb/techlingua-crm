/**
 * DOCUMENT ATTACHMENTS — shared client helpers + the uploaded-documents list.
 *
 * Used by the public admission form (upload), the admission review screen (list + download)
 * and the student profile ID & Documents tab (list + download). Kept in its OWN module so
 * both admissions.tsx and dyn.tsx can import it without a circular dependency.
 */
import { Ic } from './icons';
import { getToken } from './api';
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
