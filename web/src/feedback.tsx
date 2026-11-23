/**
 * FEEDBACK (22 Nov 2026) — "user can upload screenshots, video recording with voice to provide
 * system feedback and store in one place with status pending".
 *
 *  · FeedbackWidget — a draggable "✎ Feedback" button on every signed-in page. It files a note
 *    pinned to the page (path, title, window size, browser), with up to six screenshots (attach
 *    or paste) and a screen recording with the person's voice that survives a page change.
 *  · FeedbackPage — Help & Support › Feedback: Pending / Answered / Resolved, one conversation
 *    per note. The status always says whose turn it is: the team replies -> Answered; the
 *    reporter replies -> back to Pending; the reporter accepts -> Resolved. The team (holders of
 *    feedback.manage) sees every note; everyone else sees their own.
 *  · Out of scope (23 Nov 2026) — a note that asks for something the agreed scope documents leave
 *    out (the Scope list) is told "Out of scope — we can't take this … refer to the scope document"
 *    while it is typed, and is saved under the Out of scope tab; the team can mark any note so.
 */
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError, getToken } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, Kpis, TableCard } from './renderer';
import { toast, useFetch } from './refdata';
import { ScreenCtx } from './dyn';
import { downloadObjectsCsv } from './listtools';
import {
  MAX_BYTES, MAX_SECONDS, canRecord, clock, discardRecording, draft, startRecording, stopRecording, useRecorder,
} from './feedbackrec';
import { NEW_REQUEST_NOTICE, matchScope, scopeRef, type ScopeItem } from './feedbackscope';

/* ------------------------------------------------------------------ types + client calls */

export type FbKind = 'ISSUE' | 'SUGGESTION' | 'QUESTION' | 'PRAISE';
export type FbStatus = 'OPEN' | 'ACKNOWLEDGED' | 'ANSWERED' | 'RESOLVED' | 'WONT_FIX' | 'OUT_OF_SCOPE';
export interface FbFile { id: number; kind: 'image' | 'video'; file_name: string; mime: string; size_bytes: number }
export interface FbMessage { id: number; body: string; is_answer: boolean; created_at: string; author: { id: number; name: string; role: string | null } }
export interface FbNote {
  id: number; reference: string; page_path: string; page_title: string | null; message: string;
  kind: FbKind; status: FbStatus; created_by: number; viewport: string | null; user_agent: string | null;
  resolution: string | null; resolved_at: string | null; created_at: string;
  /** Out of scope: the scope-list item it fell under (null = a new request), and whether it was set by itself when filed. */
  scope_item_id?: number | null; scope_auto?: boolean;
  author: { id: number; name: string; role: string | null; branch: string | null };
  resolver: { id: number; name: string } | null;
  messages: FbMessage[]; screenshots: FbFile[]; recordings: FbFile[];
}

/** A file goes up as its raw bytes (a 50 MB recording is not inflated by base64 on the way). */
async function sendFile<T>(path: string, file: Blob): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: file });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(res.status, (Array.isArray(data?.message) ? data.message.join(', ') : data?.message) ?? res.statusText);
  return data as T;
}

export const fbApi = {
  file: (body: { page_path: string; page_title?: string; message: string; kind: FbKind; viewport?: string; user_agent?: string }) =>
    api.post<FbNote>('/feedback', body),
  list: (pagePath?: string) => api.get<FbNote[]>(pagePath ? `/feedback?page_path=${encodeURIComponent(pagePath)}` : '/feedback'),
  addScreenshot: (id: number, f: File) =>
    sendFile<FbFile>(`/feedback/${id}/screenshots?name=${encodeURIComponent(f.name || 'screenshot.png')}&ct=${encodeURIComponent(f.type || '')}`, f),
  addRecording: (id: number, video: Blob) =>
    sendFile<FbFile>(`/feedback/${id}/recordings?ct=${encodeURIComponent((video.type || 'video/webm').split(';')[0])}`, video),
  reply: (id: number, body: string, answer?: boolean) => api.post<FbNote>(`/feedback/${id}/replies`, { body, answer: !!answer }),
  accept: (id: number) => api.post<FbNote>(`/feedback/${id}/accept`, {}),
  resolve: (id: number, status: FbStatus, resolution?: string) => api.patch<FbNote>(`/feedback/${id}`, { status, resolution }),
  /** Out of scope — against an item on the scope list, or (null) a new request no agreed document mentions. */
  outOfScope: (id: number, scopeItemId: number | null, note?: string) =>
    api.patch<FbNote>(`/feedback/${id}`, { status: 'OUT_OF_SCOPE', scope_item_id: scopeItemId, resolution: note }),
  scope: () => api.get<ScopeItem[]>('/feedback/scope'),
  addScope: (body: Partial<ScopeItem>) => api.post<ScopeItem>('/feedback/scope', body),
  editScope: (id: number, body: Partial<ScopeItem>) => api.patch<ScopeItem>(`/feedback/scope/${id}`, body),
};

/* ------------------------------------------------------------------ words */

const KINDS: Array<{ value: FbKind; label: string }> = [
  { value: 'ISSUE', label: 'Something is wrong' },
  { value: 'SUGGESTION', label: 'Could be better' },
  { value: 'QUESTION', label: 'I have a question' },
  { value: 'PRAISE', label: 'This works well' },
];
export const KIND_LABEL: Record<string, string> = { ISSUE: 'Something is wrong', SUGGESTION: 'Could be better', QUESTION: 'A question', PRAISE: 'Works well' };
const KIND_BADGE: Record<string, string> = { ISSUE: 'b-rose', SUGGESTION: 'b-amber', QUESTION: 'b-cyan', PRAISE: 'b-green' };
export const STATUS_LABEL: Record<string, string> = { OPEN: 'Pending', ACKNOWLEDGED: 'Acknowledged', ANSWERED: 'Answered', RESOLVED: 'Resolved', WONT_FIX: "Won't fix", OUT_OF_SCOPE: 'Out of scope' };
const STATUS_BADGE: Record<string, string> = { OPEN: 'b-amber', ACKNOWLEDGED: 'b-indigo', ANSWERED: 'b-cyan', RESOLVED: 'b-green', WONT_FIX: 'b-gray', OUT_OF_SCOPE: 'b-rose' };
const isClosed = (s: string) => s === 'RESOLVED' || s === 'WONT_FIX' || s === 'OUT_OF_SCOPE';

/** The tabs, in the order a note travels — and the notes the agreed scope documents leave out. */
const TABS = [
  { key: 'PENDING', label: 'Pending', statuses: ['OPEN', 'ACKNOWLEDGED'] },
  { key: 'ANSWERED', label: 'Answered', statuses: ['ANSWERED'] },
  { key: 'RESOLVED', label: 'Resolved', statuses: ['RESOLVED', 'WONT_FIX'] },
  { key: 'OUT_OF_SCOPE', label: 'Out of scope', statuses: ['OUT_OF_SCOPE'] },
] as const;
type TabKey = typeof TABS[number]['key'];
const tabOf = (status: string): TabKey => TABS.find((t) => (t.statuses as readonly string[]).includes(status))?.key ?? 'PENDING';

const isHeicFile = (f: File) => /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type);
const isImageFile = (f: File) => f.type.startsWith('image/') || isHeicFile(f);
const dtt = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
export function age(v: string): string {
  const s = Math.max(0, (Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
/** "Chrome on Windows" — the person reading the note doesn't need the whole user-agent string. */
export function browserOf(ua: string | null | undefined): string {
  if (!ua) return '—';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

/* ------------------------------------------------------------------ the draggable button */

const DOCK_KEY = 'tl.feedback.dock';
const EDGE = 12;
type Dock = { right: number; bottom: number };
const DEFAULT_DOCK: Dock = { right: 20, bottom: 20 };

/**
 * The button sits fixed on top of every page, and a fixed thing in a corner eventually covers
 * the one control somebody needs — so it can be dragged anywhere. Kept as an offset from the
 * bottom-right, clamped to the window, remembered per browser.
 */
function useDock() {
  const [dock, setDock] = useState<Dock>(DEFAULT_DOCK);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DOCK_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Dock;
        if (Number.isFinite(d.right) && Number.isFinite(d.bottom)) setDock(clamp(d));
      }
    } catch { /* private window / blocked storage: the default is fine */ }
  }, []);
  const clamp = (d: Dock): Dock => ({
    right: Math.min(Math.max(d.right, EDGE), Math.max(EDGE, window.innerWidth - 120)),
    bottom: Math.min(Math.max(d.bottom, EDGE), Math.max(EDGE, window.innerHeight - 80)),
  });
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const startX = e.clientX, startY = e.clientY;
    const origin = dock;
    moved.current = false;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const dx = startX - ev.clientX, dy = startY - ev.clientY;
      if (!moved.current && Math.hypot(dx, dy) < 4) return;   // a shaky click is still a click
      moved.current = true;
      setDragging(true);
      setDock(clamp({ right: origin.right + dx, bottom: origin.bottom + dy }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragging(false);
      if (moved.current) setDock((d) => { try { localStorage.setItem(DOCK_KEY, JSON.stringify(d)); } catch { /* ignore */ } return d; });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return { dock, dragging, onPointerDown, consumedByDrag: () => moved.current };
}

/* ------------------------------------------------------------------ the widget */

export function FeedbackWidget({ pageTitle }: { pageTitle?: string }) {
  const { pathname } = useLocation();
  const { dock, dragging, onPointerDown, consumedByDrag } = useDock();
  const [open, setOpen] = useState(false);
  // kept beside the recording (feedbackrec.ts), so changing page while recording loses nothing
  const [kind, setKindState] = useState<FbKind>(draft.kind as FbKind);
  const [message, setMessageState] = useState(draft.message);
  const setKind = (k: FbKind) => { draft.kind = k; setKindState(k); };
  const setMessage = (m: string) => { draft.message = m; setMessageState(m); };
  const rec = useRecorder();
  const [voice, setVoice] = useState(true);
  const [recordable, setRecordable] = useState(false);
  const [now, setNow] = useState(Date.now());
  // the saved note's reference — and, when the agreed scope leaves it out, what the scope document says
  const [sent, setSent] = useState<{ ref: string; outOfScope: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [shots, setShotsState] = useState<Array<{ file: File; url: string }>>(draft.shots);
  const setShots = (u: Array<{ file: File; url: string }> | ((p: Array<{ file: File; url: string }>) => Array<{ file: File; url: string }>)) =>
    setShotsState((prev) => { const next = typeof u === 'function' ? u(prev) : u; draft.shots = next; return next; });
  const [prior, setPrior] = useState<FbNote[] | null>(null);
  const [priorTick, setPriorTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setRecordable(canRecord()); }, []);
  // the clock on the recording pill
  useEffect(() => {
    if (rec.status !== 'recording') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [rec.status]);
  // a finished recording opens the note again, ready to send
  const lastStatus = useRef(rec.status);
  useEffect(() => {
    if (rec.status === 'done' && lastStatus.current !== 'done') { setOpen(true); setSent(null); }
    lastStatus.current = rec.status;
  }, [rec.status]);
  const recording = rec.status === 'done' ? rec : null;
  const tooBig = !!recording && recording.blob.size > MAX_BYTES;

  // 23 Nov 2026 — out of scope: the scope list is read when the panel opens, and the note is checked
  // against it as it is typed, so "we can't take this — refer to the scope document" shows BEFORE it
  // is sent. The API checks again when it is saved (its answer is the one that counts).
  const [scope, setScope] = useState<ScopeItem[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fbApi.scope().then((r) => { if (alive) setScope(Array.isArray(r) ? r : []); }).catch(() => { /* the API still checks on save */ });
    return () => { alive = false; };
  }, [open]);
  const scopeHit = useMemo(() => matchScope(scope, message, recording?.startPath ?? pathname), [scope, message, recording, pathname]);

  const addShots = (files: FileList | File[] | null) => {
    if (!files) return;
    const images = [...files].filter(isImageFile);
    if (!images.length) return;
    setShots((prev) => [...prev, ...images.slice(0, Math.max(0, 6 - prev.length)).map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  // what has already been said about this page, so nobody reports it twice
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fbApi.list(pathname).then((r) => { if (alive) setPrior(r); }).catch(() => { if (alive) setPrior([]); });
    return () => { alive = false; };
  }, [open, pathname, priorTick]);

  // Escape closes; a fresh page starts a fresh note (the words and a recording are kept)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // a page change closes the panel but keeps the unsent note (words, screenshots, recording)
  useEffect(() => { setOpen(false); setSent(null); setError(null); }, [pathname]);

  // 23 Nov 2026 — two notes were lost: the person recorded, the panel came back with the preview,
  // and the Send button sat below the fold, so they closed it thinking it was saved. Now Send is
  // always visible, an unsent note says so on the button, and leaving the CRM warns first.
  const unsent = !sent && (message.trim().length > 0 || shots.length > 0 || !!recording || rec.status === 'recording');
  useEffect(() => {
    if (!unsent) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent]);

  // most screenshots arrive on the clipboard, not as a saved file
  useEffect(() => {
    if (!open || sent) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.some(isImageFile)) { e.preventDefault(); addShots(files); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, sent]);

  const send = async () => {
    setSending(true); setError(null);
    try {
      const row = await fbApi.file({
        page_path: recording?.startPath ?? pathname,   // a recording is about the page it started on
        page_title: recording ? (recording.startTitle ?? undefined) : pageTitle,
        message: message.trim().length >= 3 ? message.trim() : 'Screen recording — see the video',
        kind,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        user_agent: navigator.userAgent,
      });
      // the note exists first; one failed upload never loses it — the words matter most
      const failed: string[] = [];
      for (const s of shots) {
        try { await fbApi.addScreenshot(row.id, s.file); } catch (e) { failed.push(`a screenshot (${(e as Error).message})`); }
        URL.revokeObjectURL(s.url);
      }
      if (recording) {
        try { await fbApi.addRecording(row.id, recording.blob); } catch (e) { failed.push(`the recording (${(e as Error).message})`); }
        discardRecording();
      }
      if (failed.length) setError(`The note was saved, but ${failed.join(' and ')} would not upload.`);
      setSent({ ref: row.reference, outOfScope: row.status === 'OUT_OF_SCOPE' ? (row.resolution ?? '') : null });
      setMessage(''); setKind('ISSUE'); setShots([]);
      setPriorTick((t) => t + 1);
      // the Feedback page, if it is open behind the panel, shows the new note straight away
      window.dispatchEvent(new CustomEvent('tl:feedback-sent', { detail: { id: row.id } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That note could not be saved.');
    } finally { setSending(false); }
  };

  const openCount = prior?.filter((f) => f.status === 'OPEN' || f.status === 'ACKNOWLEDGED').length ?? 0;
  const canSend = !sending && !tooBig && (message.trim().length >= 3 || !!recording);

  return (
    <>
      <button type="button" data-testid="fb-launch"
        className={`fb-launch${open ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}${!open && unsent ? ' is-unsent' : ''}`}
        style={{ right: dock.right, bottom: dock.bottom }}
        onPointerDown={onPointerDown}
        onClick={() => { if (!consumedByDrag()) setOpen((v) => !v); }}
        aria-expanded={open}
        aria-label="Leave feedback on this page — drag to move"
        title="Leave feedback on this page (drag to move)">
        <Ic k={open ? 'x' : 'pencil'} />
        <span className="fb-launch__text">{open ? 'Close' : unsent ? 'Feedback · not sent yet' : 'Feedback'}</span>
        {!open && unsent ? <span className="fb-launch__dot" aria-label="A note is waiting to be sent" /> : null}
      </button>

      {rec.status === 'recording' && (
        <div className="fb-rec" style={{ right: dock.right, bottom: dock.bottom + 54 }} role="status" aria-live="polite" data-testid="fb-recpill">
          <span className="fb-rec__dot" aria-hidden />
          <span className="fb-rec__time mono">{clock(Math.min(MAX_SECONDS, Math.floor((now - rec.startedAt) / 1000)))}</span>
          <span className="fb-rec__label">{rec.voice ? 'Recording the screen and your voice' : 'Recording the screen'}</span>
          <button type="button" className="btn sm primary" onClick={() => stopRecording()} data-testid="fb-rec-stop">Stop</button>
          <button type="button" className="fb-rec__x" aria-label="Stop and throw the recording away" title="Stop and throw the recording away" onClick={() => discardRecording()}><Ic k="x" /></button>
        </div>
      )}

      {open && (
        <div className="fb-panel" style={{ right: dock.right, bottom: dock.bottom + 54 }} role="dialog" aria-label="Page feedback" data-testid="fb-panel">
          <div className="fb-panel__head">
            <div className="fb-panel__title">Feedback on this page</div>
            <div className="fb-panel__path mono" title={pathname}>{pageTitle ? `${pageTitle} · ` : ''}{pathname}</div>
          </div>

          {sent ? (
            <div className="fb-panel__body">
              {sent.outOfScope != null ? (
                <div className="fb-sent fb-sent--out" data-testid="fb-sent">
                  <div className="fb-sent__ref mono">{sent.ref}</div>
                  <p data-testid="fb-sent-scope">{sent.outOfScope}</p>
                  <p className="fb-hint">Recorded under Help &amp; Support › Feedback › Out of scope. If it is really a problem with a screen you already use, reply on the note there and the team will look at it again.</p>
                </div>
              ) : (
                <div className="fb-sent" data-testid="fb-sent">
                  <div className="fb-sent__ref mono">{sent.ref}</div>
                  <p>Sent to the team with the page and your screen size. You'll find it, and the team's answer, in Help &amp; Support › Feedback.</p>
                </div>
              )}
              {error && <div className="fb-error">{error}</div>}
              <button className="btn sm" onClick={() => { setSent(null); setError(null); }}>Add another</button>
            </div>
          ) : (
            <div className="fb-panel__body">
              <div className="fb-kinds" role="radiogroup" aria-label="What kind of feedback">
                {KINDS.map((k) => (
                  <button key={k.value} type="button" role="radio" aria-checked={kind === k.value}
                    className={`fb-kind${kind === k.value ? ' is-active' : ''}`} onClick={() => setKind(k.value)}>{k.label}</button>
                ))}
              </div>
              {kind === 'SUGGESTION' && (
                <div className="fb-hint" data-testid="fb-new-hint">Asking for something new? Only what the agreed scope documents cover can be taken — anything else is closed as out of scope.</div>
              )}

              <textarea className="ainp fb-text" rows={4} value={message} autoFocus data-testid="fb-message"
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What did you expect to see, and what did you see instead?" />

              {scopeHit && (
                <div className="fb-scope" role="alert" data-testid="fb-scope">
                  <div className="fb-scope__head"><Ic k="ban" /><b>Out of scope — we can't take this.</b></div>
                  <div>“{scopeHit.item.title}” is not available in this project{scopeHit.by === 'page' ? ' (this screen belongs to it)' : ''}.</div>
                  <div className="fb-scope__ref">Please refer to the scope document: {scopeRef(scopeHit.item)}.</div>
                  <div className="fb-hint">If you send it, it is recorded as out of scope. If it is really a problem with a screen you already use, send it and reply on the note — the team will look again.</div>
                </div>
              )}

              {recordable && (
                <div className="fb-recbox">
                  {recording ? (
                    <>
                      <div className="fb-ready" data-testid="fb-ready"><b>Recording ready.</b> It is not saved yet — press <b>Send to the team</b> below.</div>
                      <video className="fb-recbox__video" src={recording.url} controls preload="metadata" />
                      <div className="fb-row">
                        <span className="sub">Screen recording · {clock(recording.seconds)} · {mb(recording.blob.size)}{recording.voice ? ' · with your voice' : ''}</span>
                        <button type="button" className="btn sm" onClick={() => discardRecording()}>Remove</button>
                      </div>
                      {tooBig && <div className="fb-error">This recording is over 50 MB. Record a shorter one.</div>}
                    </>
                  ) : (
                    <>
                      <div className="fb-row" style={{ justifyContent: 'flex-start', gap: 12 }}>
                        <button type="button" className="btn sm" data-testid="fb-record"
                          disabled={rec.status === 'asking' || rec.status === 'recording'}
                          onClick={async () => {
                            // out of the way once it records, so the page can be shown
                            if (await startRecording({ voice, path: pathname, title: pageTitle }) === 'recording') setOpen(false);
                          }}>
                          <span className="fb-rec__dot" aria-hidden /> {rec.status === 'asking' ? 'Choose what to share…' : 'Record the screen'}
                        </button>
                        <label className="fb-check"><input type="checkbox" checked={voice} onChange={() => setVoice(!voice)} /> With my voice</label>
                      </div>
                      <div className="fb-hint">Show what happens and talk it through — up to 10 minutes. You can move between pages while it records. The browser asks which tab or screen to share, and for the microphone.</div>
                    </>
                  )}
                  {rec.status === 'error' && (
                    <div className="fb-error">
                      {rec.reason === 'unsupported' ? 'This browser cannot record the screen. Use Chrome, Edge or Firefox on a computer.'
                        : rec.reason === 'empty' ? 'Nothing was recorded. Try again.'
                          : 'The screen could not be recorded. Check that the browser allows screen sharing for this site.'}
                    </div>
                  )}
                </div>
              )}

              <div className="fb-shots">
                {shots.map((s, i) => (
                  <div key={s.url} className="fb-shot">
                    {isHeicFile(s.file) ? <span className="fb-shot__name">{s.file.name}</span> : <img src={s.url} alt={`Screenshot ${i + 1}`} />}
                    <button type="button" className="fb-shot__x" aria-label="Remove this screenshot"
                      onClick={() => { URL.revokeObjectURL(s.url); setShots((p) => p.filter((x) => x.url !== s.url)); }}><Ic k="x" /></button>
                  </div>
                ))}
                {shots.length < 6 && (
                  <button type="button" className="fb-shot fb-shot--add" onClick={() => fileRef.current?.click()} title="Attach a screenshot, or just paste one" aria-label="Attach a screenshot">
                    <Ic k="plus" />
                  </button>
                )}
              </div>
              <div className="fb-hint" style={{ marginTop: -4 }}>Attach up to six screenshots, or paste one straight in (Ctrl+V).</div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif" multiple
                style={{ display: 'none' }} data-testid="fb-file"
                onChange={(e) => { addShots(e.target.files); e.target.value = ''; }} />

              {!!prior?.length && <PriorNotes prior={prior} openCount={openCount} />}
            </div>
          )}
          {!sent && (
            <div className="fb-panel__foot">
              {error && <div className="fb-error" data-testid="fb-error">{error}</div>}
              <button className="btn primary fb-send" disabled={!canSend} onClick={send} data-testid="fb-send">
                <Ic k="send" />{sending ? (shots.length || recording ? 'Saving and uploading…' : 'Saving…') : scopeHit ? 'Send anyway' : 'Send to the team'}
              </button>
            </div>
          )}
          {sent && !!prior?.length && (
            <div className="fb-panel__prior"><PriorNotes prior={prior} openCount={openCount} /></div>
          )}
        </div>
      )}
    </>
  );
}

/** Earlier notes on this page, so nobody reports the same thing twice. */
function PriorNotes({ prior, openCount }: { prior: FbNote[]; openCount: number }) {
  return (
    <div className="fb-prior">
      <div className="fb-panel__priorhead">
        Already reported here
        {openCount > 0 && <span className="fb-count">{openCount} pending</span>}
      </div>
      <ul className="fb-list">
        {prior.slice(0, 6).map((f) => (
          <li key={f.id} className={`fb-item is-${f.status.toLowerCase()}`}>
            <span className="fb-item__msg">{f.message}</span>
            <span className="fb-item__meta mono">{f.reference} · {STATUS_LABEL[f.status] ?? f.status}</span>
            {f.resolution && <span className="fb-item__res">{f.resolution}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ files on the page */

/** A screenshot thumbnail or a recording player. R2 files open by a short-lived signed link. */
function FbMedia({ f }: { f: FbFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let blobUrl: string | null = null;
    (async () => {
      try {
        const r = await api.get<{ url: string | null }>(`/feedback/files/${f.id}`);
        if (r?.url) { if (alive) setUrl(r.url); return; }
        const res = await fetch(`/api/feedback/files/${f.id}/raw`, { headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) throw new Error('unavailable');
        blobUrl = URL.createObjectURL(await res.blob());
        if (alive) setUrl(blobUrl);
      } catch { if (alive) setFailed(true); }
    })();
    return () => { alive = false; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [f.id]);

  if (failed) return <div className={f.kind === 'video' ? 'fb-note' : 'fb-thumb fb-thumb--blocked'} title={f.file_name}>{f.kind === 'video' ? 'The recording could not be opened.' : 'unavailable'}</div>;
  if (!url) return <div className={f.kind === 'video' ? 'fb-video fb-thumb--loading' : 'fb-thumb fb-thumb--loading'} />;
  if (f.kind === 'video') {
    return (
      <div className="fb-videobox">
        <video className="fb-video" src={url} controls preload="metadata" data-testid={`fb-video-${f.id}`}
          onLoadedMetadata={(e) => {
            // a browser's WebM recording carries no length: nudge to the end once so the seek bar works
            const v = e.currentTarget;
            if (v.duration === Infinity) {
              v.currentTime = 1e9;
              const back = () => { v.removeEventListener('timeupdate', back); v.currentTime = 0; };
              v.addEventListener('timeupdate', back);
            }
          }} />
        <div className="fb-row sub"><span>{mb(f.size_bytes)}</span><a className="lnk" href={url} target="_blank" rel="noreferrer">Open in a new tab</a></div>
      </div>
    );
  }
  if (f.mime === 'image/heic') {
    return <a className="fb-thumb fb-thumb--blocked" href={url} download={f.file_name} title="iPhone photo — most browsers can't show it; download to open">{f.file_name}</a>;
  }
  return (
    <a className="fb-thumb" href={url} target="_blank" rel="noreferrer" title={`${f.file_name} — open full size`} data-testid={`fb-shot-${f.id}`}>
      <img src={url} alt={f.file_name} onError={() => setFailed(true)} />
    </a>
  );
}

/* ------------------------------------------------------------------ the note, and the thread */

function PageLink({ path, title }: { path: string; title: string | null }) {
  const screen = useContext(ScreenCtx);
  const m = /^\/m\/([^/]+)\/([^/?#]+)/.exec(path);
  if (!m || !screen?.go) return <span className="mono">{title || path}</span>;
  return <a className="lnk mono" onClick={() => screen.go(m[1], m[2])} title={path}>{title || path}</a>;
}

function FeedbackDetail({ id, team, meId, onClose, onChanged }: { id: number; team: boolean; meId: number; onClose: () => void; onChanged: () => void }) {
  const [tick, setTick] = useState(0);
  const { data: n } = useFetch<FbNote>(`/feedback/${id}`, [tick]);
  const [reply, setReply] = useState('');
  const [asAnswer, setAsAnswer] = useState(true);
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // the team marking it Out of scope: which item on the scope list ('' = a new request in no agreed document)
  const [scoping, setScoping] = useState(false);
  const [scopeSel, setScopeSel] = useState('');
  const scopeList = useFetch<ScopeItem[]>(team && scoping ? '/feedback/scope' : null, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>, ok: string, close = false) => {
    setBusy(true); setErr(null);
    try { await fn(); toast(ok); onChanged(); if (close) onClose(); else setTick((t) => t + 1); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!n) {
    return <div className="add-scrim"><div className="add-modal" style={{ maxWidth: 760 }}><div className="abody"><div className="empty-note">Loading…</div></div></div></div>;
  }
  const mine = n.created_by === meId;
  const closed = isClosed(n.status);
  // a team member writing on their own note chooses: their answer (waits on the reporter) or a follow-up
  const answerChoice = team && mine;

  return (
    <div className="add-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="add-modal" style={{ maxWidth: 760 }} data-testid="fb-detail">
        <div className="ah">
          <h3><Ic k="chat" />{n.reference} · {KIND_LABEL[n.kind] ?? n.kind}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="fb-row" style={{ alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <b>{n.author.name}</b>
              <div className="sub">{[n.author.role, n.author.branch].filter(Boolean).join(' · ')}{n.author.role || n.author.branch ? ' · ' : ''}{dtt(n.created_at)} ({age(n.created_at)} ago)</div>
            </div>
            <span className={`bdg ${STATUS_BADGE[n.status] ?? 'b-gray'}`} data-testid="fb-status">{STATUS_LABEL[n.status] ?? n.status}</span>
          </div>

          <blockquote className="fb-quote">{n.message}</blockquote>

          <div className="fb-meta sub">
            <span>Left on <PageLink path={n.page_path} title={n.page_title} /></span>
            <span>Screen {n.viewport ?? '—'}</span>
            <span>{browserOf(n.user_agent)}</span>
          </div>

          {n.recordings.length > 0 && (
            <div className="fb-section">
              <div className="fb-label">Screen recording</div>
              {n.recordings.map((r) => <FbMedia key={r.id} f={r} />)}
            </div>
          )}
          {n.screenshots.length > 0 && (
            <div className="fb-section">
              <div className="fb-label">Screenshots</div>
              <div className="fb-thumbs">{n.screenshots.map((s) => <FbMedia key={s.id} f={s} />)}</div>
            </div>
          )}

          {n.messages.length > 0 && (
            <div className="fb-section">
              <div className="fb-label">Conversation</div>
              {n.messages.map((m) => (
                <div key={m.id} className={`fbmsg${m.is_answer ? ' fbmsg--us' : ''}`}>
                  <div className="fbmsg__who">{m.author.name}{m.author.role ? <span className="sub"> · {m.author.role}</span> : null}<span className="fbmsg__when mono">{dtt(m.created_at)}</span></div>
                  <div className="fbmsg__body">{m.body}</div>
                </div>
              ))}
            </div>
          )}

          {closed && n.resolution && (
            n.status === 'OUT_OF_SCOPE' ? (
              <div className="fb-section">
                <div className="fb-label">Out of scope{n.scope_auto ? ' — set by itself when it was sent' : ''}</div>
                <div className="fb-outcome fb-outcome--out" data-testid="fb-scope-outcome"><Ic k="ban" /><div>{n.resolver ? <b>{n.resolver.name}: </b> : null}{n.resolution}</div></div>
              </div>
            ) : (
              <div className="fb-section">
                <div className="fb-label">Outcome</div>
                <div className="fb-outcome"><Ic k="check" /><div>{n.resolver ? <b>{n.resolver.name}: </b> : null}{n.resolution}</div></div>
              </div>
            )
          )}

          {(mine || team) && (
            <div className="fb-section">
              <label className="fb-label" htmlFor={`fb-rep-${n.id}`}>{team && !mine ? 'Answer them' : 'Reply'}</label>
              <textarea id={`fb-rep-${n.id}`} className="ainp" rows={3} value={reply} data-testid="fb-reply"
                placeholder={team && !mine ? 'They will read this and decide whether it settles it.' : 'Say whether this answers it, or ask again.'}
                onChange={(e) => { setReply(e.target.value); setErr(null); }} />
              {answerChoice && (
                <label className="fb-check" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={asAnswer} onChange={() => setAsAnswer(!asAnswer)} /> This is the team's answer (it then waits on the reporter)
                </label>
              )}
              <div className="fb-row" style={{ marginTop: 8 }}>
                <span className="fb-hint">
                  {n.status === 'OUT_OF_SCOPE' ? (n.scope_auto
                    ? (mine ? 'Closed by itself as out of scope. If it is really a problem with a screen you already use, reply and the team will look again.'
                      : 'Closed by itself as out of scope. A reply from the reporter puts it back in Pending.')
                    : "Out of scope — a reply doesn't change that.")
                    : n.status === 'WONT_FIX' ? "Marked won't fix — a reply doesn't change that."
                    : n.status === 'ANSWERED' ? 'Waiting on the person who reported it.'
                      : closed ? (mine ? 'Resolved. Replying puts it back with the team.' : 'Resolved.')
                        : 'Waiting on the team.'}
                </span>
                <button className="btn sm primary" disabled={busy || reply.trim().length < 2} data-testid="fb-reply-send"
                  onClick={() => act(() => fbApi.reply(n.id, reply.trim(), answerChoice ? asAnswer : undefined).then(() => setReply('')), 'Sent')}>
                  <Ic k="send" />{busy ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}

          {team && !closed && (
            <div className="fb-section">
              <label className="fb-label" htmlFor={`fb-res-${n.id}`}>Outcome note (shown when you close it)</label>
              <input id={`fb-res-${n.id}`} className="ainp" value={resolution} onChange={(e) => setResolution(e.target.value)}
                placeholder="e.g. Fixed on 22 Nov — the column now shows the deadline" data-testid="fb-resolution" />
            </div>
          )}

          {team && !closed && scoping && (
            <div className="fb-section fb-scopepick" data-testid="fb-scopepick">
              <label className="fb-label" htmlFor={`fb-scope-${n.id}`}>Out of scope — which part of the scope documents leaves it out?</label>
              <select id={`fb-scope-${n.id}`} className="ainp" value={scopeSel} onChange={(e) => setScopeSel(e.target.value)} data-testid="fb-scope-item">
                <option value="">New request — not in any agreed scope document</option>
                {(scopeList.data ?? []).filter((s) => s.is_active || String(s.id) === scopeSel).map((s) => <option key={s.id} value={String(s.id)}>{s.title}</option>)}
              </select>
              <div className="fb-scope fb-scope--preview">
                <div className="fb-scope__head"><Ic k="ban" /><b>What {mine ? 'the note' : n.author.name} will read</b></div>
                <div>{(() => {
                  const it = (scopeList.data ?? []).find((s) => String(s.id) === scopeSel);
                  const base = it ? (it.notice ?? '') : NEW_REQUEST_NOTICE;
                  return resolution.trim() ? `${base} Note from the team: ${resolution.trim()}` : base;
                })()}</div>
                <div className="fb-hint">The outcome note above, if any, is added after the scope document's words.</div>
              </div>
            </div>
          )}

          {err && <div className="fb-error" style={{ marginTop: 10 }} data-testid="fb-detail-error">{err}</div>}
        </div>
        <div className="af">
          {/* the person who asked decides whether it is settled — their button leads */}
          {mine && !closed && (
            <button className="btn primary" disabled={busy} data-testid="fb-accept"
              onClick={() => act(() => fbApi.accept(n.id), 'Marked resolved', true)}><Ic k="check" />That answers it</button>
          )}
          {team && n.status === 'OPEN' && (
            <button className="btn" disabled={busy} data-testid="fb-ack"
              onClick={() => act(() => fbApi.resolve(n.id, 'ACKNOWLEDGED'), 'Acknowledged')}><Ic k="eye" />Acknowledge</button>
          )}
          {team && !closed && (
            scoping ? (
              <>
                <button className="btn fb-btn-out" disabled={busy} data-testid="fb-scope-confirm"
                  onClick={() => act(() => fbApi.outOfScope(n.id, scopeSel ? Number(scopeSel) : null, resolution.trim() || undefined), 'Marked out of scope', true)}>
                  <Ic k="ban" />Mark out of scope</button>
                <button className="btn" disabled={busy} onClick={() => setScoping(false)}>Back</button>
              </>
            ) : (
              <button className="btn" disabled={busy} data-testid="fb-scope" onClick={() => { setScoping(true); setErr(null); }}
                title="Not in the agreed scope documents: the reporter is told so, with the document reference"><Ic k="ban" />Out of scope</button>
            )
          )}
          {team && !closed && !scoping && (
            <>
              <button className="btn" disabled={busy} data-testid="fb-wontfix"
                onClick={() => act(() => fbApi.resolve(n.id, 'WONT_FIX', resolution.trim() || undefined), "Marked won't fix", true)}><Ic k="ban" />Won't fix</button>
              <button className="btn" disabled={busy} data-testid="fb-resolve"
                onClick={() => act(() => fbApi.resolve(n.id, 'RESOLVED', resolution.trim() || undefined), 'Resolved', true)}><Ic k="check" />Resolve</button>
            </>
          )}
          {team && closed && (
            <button className="btn" disabled={busy} data-testid="fb-reopen"
              onClick={() => act(() => fbApi.resolve(n.id, 'OPEN'), 'Reopened')}><Ic k="undo" />Reopen</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Help & Support › Feedback */

export function FeedbackPage() {
  const { can, me } = useAuth();
  const team = can('feedback.manage');
  const meId = Number(me?.user?.id ?? 0);
  const screen = useContext(ScreenCtx);
  const [tick, setTick] = useState(0);
  const list = useFetch<FbNote[]>('/feedback', [tick]);
  const sum = useFetch<{ pending: number; answered: number; resolved: number; wont_fix: number; out_of_scope?: number }>('/feedback/summary', [tick]);
  const [tab, setTab] = useState<TabKey>('PENDING');
  const [showScope, setShowScope] = useState(false);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const fbParam = () => Number(new URLSearchParams(screen?.search ?? '').get('fb')) || null;
  const [openId, setOpenId] = useState<number | null>(fbParam);
  // a note sent from the Feedback button while this page is open shows up at once
  useEffect(() => {
    const onSent = () => setTick((t) => t + 1);
    window.addEventListener('tl:feedback-sent', onSent);
    return () => window.removeEventListener('tl:feedback-sent', onSent);
  }, []);
  // a notification click (`?fb=<id>`) opens that note
  useEffect(() => { const id = fbParam(); if (id) setOpenId(id); }, [screen?.search]);

  const all = list.data ?? [];
  const inTab = (k: TabKey) => all.filter((f) => tabOf(f.status) === k).length;
  const needle = q.trim().toLowerCase();
  const items = useMemo(() => all.filter((f) => {
    if (tabOf(f.status) !== tab) return false;
    if (kind && f.kind !== kind) return false;
    if (needle.length < 2) return true;
    return [f.reference, f.message, f.author?.name, f.page_title, f.page_path].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle));
  }), [all, tab, kind, needle]);
  const withFiles = all.filter((f) => f.screenshots.length || f.recordings.length).length;
  const s = sum.data;

  const rows: Cell[][] = items.map((f) => [
    { mono: f.reference },
    { node: (
      <button className="fb-cell" onClick={() => setOpenId(f.id)} data-testid={`fb-row-${f.id}`}>
        <span className="fb-line">{f.message}</span>
        {(f.screenshots.length > 0 || f.recordings.length > 0) && (
          <span className="sub">
            {f.screenshots.length ? `${f.screenshots.length} screenshot${f.screenshots.length > 1 ? 's' : ''}` : ''}
            {f.screenshots.length && f.recordings.length ? ' · ' : ''}
            {f.recordings.length ? '▶ screen recording' : ''}
          </span>
        )}
      </button>
    ), sort: f.message },
    { b: [KIND_LABEL[f.kind] ?? f.kind, KIND_BADGE[f.kind] ?? 'b-gray'] },
    { node: <PageLink path={f.page_path} title={f.page_title} />, sort: f.page_title ?? f.page_path },
    { node: <span><b>{f.author.name}</b>{f.author.role ? <span className="sub"> · {f.author.role}</span> : null}</span>, sort: f.author.name },
    { node: <span title={dtt(f.created_at)}>{age(f.created_at)}</span>, sort: f.created_at },
    { b: [STATUS_LABEL[f.status] ?? f.status, STATUS_BADGE[f.status] ?? 'b-gray'] },
    { node: <button className="btn sm" onClick={() => setOpenId(f.id)}><Ic k="eye" />{team && !isClosed(f.status) ? 'Review' : 'Open'}</button> },
  ]);

  return (
    <>
      <div className="notice" style={{ marginBottom: 12 }}>
        <Ic k="pencil" />
        <div>
          {team
            ? <>Every note left on any page, by anyone, with the screen it came from. <b>Pending</b> is the to-do list: a reporter's reply puts a note back here by itself. A note that asks for something on the <b>Scope list</b> is closed as <b>Out of scope</b> by itself, with the scope document's reference.</>
            : <>The notes you've left and what has been done about them. To add one, use the <b>Feedback</b> button at the bottom-right of any page — attach screenshots or record your screen with your voice. What the agreed scope leaves out is on the <b>Scope list</b>.</>}
        </div>
      </div>
      <Kpis cols={5} items={[
        { lab: 'Pending', val: String(s?.pending ?? inTab('PENDING')), ic: 'clock' },
        { lab: 'Answered — waiting on the reporter', val: String(s?.answered ?? inTab('ANSWERED')), ic: 'chat' },
        { lab: 'Resolved', val: String(s ? s.resolved + s.wont_fix : inTab('RESOLVED')), ic: 'check' },
        { lab: 'Out of scope', val: String(s?.out_of_scope ?? inTab('OUT_OF_SCOPE')), ic: 'ban' },
        { lab: 'With a screenshot or recording', val: String(withFiles), ic: 'eye' },
      ]} />

      <div className="seg-tabs" role="tablist" style={{ display: 'flex', gap: 6, margin: '12px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`btn${tab === t.key ? ' primary' : ''}`}
            onClick={() => setTab(t.key)} data-testid={`fb-tab-${t.key}`}>
            {t.label}<span className="fb-pill">{inTab(t.key)}</span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <input className="ainp" style={{ width: 240 }} placeholder="Message, person, page…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="fb-search" />
        <select className="ainp" style={{ width: 'auto' }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
          <option value="">All kinds</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn" onClick={() => setShowScope(true)} data-testid="fb-scope-list"
          title="What the agreed scope documents leave out — a note asking for one of these is out of scope"><Ic k="doc" />Scope list</button>
        <button className="btn" onClick={() => setTick((t) => t + 1)} title="Refresh"><Ic k="refresh" /></button>
        <button className="btn" disabled={!items.length} onClick={() => downloadObjectsCsv(`feedback-${new Date().toISOString().slice(0, 10)}.csv`,
          items.map((f) => ({
            Reference: f.reference, Kind: KIND_LABEL[f.kind] ?? f.kind, Status: STATUS_LABEL[f.status] ?? f.status, Message: f.message,
            Page: f.page_title ?? f.page_path, Path: f.page_path, From: f.author.name, Role: f.author.role ?? '', Raised: dtt(f.created_at),
            Screenshots: f.screenshots.length, Recordings: f.recordings.length, Replies: f.messages.length, Outcome: f.resolution ?? '',
          })))}><Ic k="export" />Export</button>
      </div>

      <TableCard icon="chat" title={`${TABS.find((t) => t.key === tab)?.label} · ${items.length}`}
        cols={['Reference', 'What was said', 'Kind', 'Page', 'From', 'Age', 'Status', '']}
        rows={rows}
        empty={list.loading ? 'Loading…'
          : q || kind ? 'Nothing matches that.'
            : !all.length ? 'Nothing reported yet. The Feedback button sits at the bottom-right of every page.'
              : tab === 'PENDING' ? 'Nothing pending — every note has been answered.'
                : tab === 'ANSWERED' ? 'Nothing waiting on a reporter.'
                  : tab === 'OUT_OF_SCOPE' ? 'Nothing out of scope.' : 'Nothing resolved yet.'} />

      {openId != null && (
        <FeedbackDetail key={openId} id={openId} team={team} meId={meId}
          onClose={() => setOpenId(null)} onChanged={() => setTick((t) => t + 1)} />
      )}
      {showScope && <ScopeListModal team={team} onClose={() => setShowScope(false)} />}
    </>
  );
}

/* ------------------------------------------------------------------ the scope list */

const linesOf = (v: string) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

/**
 * What the agreed scope documents leave out, each with where the document says so. Everyone can
 * read it; the team (feedback.manage) adds, edits and switches items off. A note that names one of
 * these (its words) or is left on one of its screens is told "out of scope — we can't take this".
 */
function ScopeListModal({ team, onClose }: { team: boolean; onClose: () => void }) {
  const [tick, setTick] = useState(0);
  const { data, loading } = useFetch<ScopeItem[]>('/feedback/scope', [tick]);
  const [edit, setEdit] = useState<Partial<ScopeItem> & { phrasesText?: string; pathsText?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (edit) setEdit(null); else onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, edit]);
  const items = data ?? [];

  const save = async () => {
    if (!edit) return;
    setBusy(true); setErr(null);
    const body: Partial<ScopeItem> = {
      title: edit.title ?? '', reference: edit.reference ?? '', doc_says: edit.doc_says ?? null,
      phrases: linesOf(edit.phrasesText ?? ''), page_paths: linesOf(edit.pathsText ?? ''), is_active: edit.is_active !== false,
    };
    try {
      if (edit.id) await fbApi.editScope(edit.id, body); else await fbApi.addScope(body);
      toast(edit.id ? 'Scope list updated' : 'Added to the scope list');
      setEdit(null); setTick((t) => t + 1);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const toggle = async (it: ScopeItem) => {
    setBusy(true); setErr(null);
    try { await fbApi.editScope(it.id, { is_active: !it.is_active }); toast(it.is_active ? 'Switched off' : 'Switched on'); setTick((t) => t + 1); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="add-modal" style={{ maxWidth: 920 }} data-testid="fb-scope-modal">
        <div className="ah">
          <h3><Ic k="doc" />Scope list — what the agreed documents leave out</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="notice" style={{ marginBottom: 12 }}>
            <Ic k="ban" />
            <div>A feedback note that asks for one of these is told <b>“Out of scope — we can't take this”</b>, with the document and section below, and is kept under the <b>Out of scope</b> tab. Bugs and changes on screens that are already in the system are not on this list.{team ? ' A note is matched by the words listed (whole words) or by being left on one of the screens listed.' : ''}</div>
          </div>
          {edit ? (
            <div className="fb-scopeform" data-testid="fb-scope-form">
              <label className="fb-label" htmlFor="sc-title">What is out of scope</label>
              <input id="sc-title" className="ainp" value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="e.g. Tally export of collections" />
              <label className="fb-label" htmlFor="sc-ref">Where the scope document says so</label>
              <input id="sc-ref" className="ainp" value={edit.reference ?? ''} onChange={(e) => setEdit({ ...edit, reference: e.target.value })} placeholder="e.g. Client Requirements Discovery Document, §6 Finance › Collection reports" />
              <label className="fb-label" htmlFor="sc-says">What it says there (optional)</label>
              <input id="sc-says" className="ainp" value={edit.doc_says ?? ''} onChange={(e) => setEdit({ ...edit, doc_says: e.target.value })} placeholder={'e.g. answered "Not required"'} />
              <label className="fb-label" htmlFor="sc-words">Words in a note that mean it — one per line</label>
              <textarea id="sc-words" className="ainp" rows={4} value={edit.phrasesText ?? ''} onChange={(e) => setEdit({ ...edit, phrasesText: e.target.value })} placeholder={'tally export\ntally sync'} />
              <div className="fb-hint">Whole words only. Keep them specific — a loose word (like “transfer”) would turn away bugs on screens you already have.</div>
              <label className="fb-label" htmlFor="sc-paths">Its screens (optional) — one per line</label>
              <textarea id="sc-paths" className="ainp" rows={2} value={edit.pathsText ?? ''} onChange={(e) => setEdit({ ...edit, pathsText: e.target.value })} placeholder="/m/hr/hiring" />
              <label className="fb-check"><input type="checkbox" checked={edit.is_active !== false} onChange={() => setEdit({ ...edit, is_active: edit.is_active === false })} /> Switched on</label>
              {(edit.title ?? '').trim() && (edit.reference ?? '').trim() && (
                <div className="fb-scope fb-scope--preview">
                  <div className="fb-scope__head"><Ic k="ban" /><b>The reporter will read</b></div>
                  <div>Out of scope — we can't take this. “{edit.title?.trim()}” is not available in this project. Please refer to the scope document: {scopeRef({ reference: edit.reference?.trim() ?? '', doc_says: edit.doc_says?.trim() || null })}.</div>
                </div>
              )}
            </div>
          ) : (
            <TableCard icon="doc" title={`Out of scope · ${items.filter((i) => i.is_active).length}`}
              cols={team ? ['What', 'Where the scope document says so', 'Matched by', 'On', ''] : ['What', 'Where the scope document says so']}
              rows={items.map((it): Cell[] => {
                const base: Cell[] = [
                  { node: <b style={{ opacity: it.is_active ? 1 : 0.55 }}>{it.title}</b>, sort: it.title },
                  { node: <span className="sub">{scopeRef(it)}</span>, sort: it.reference },
                ];
                if (!team) return base;
                return [...base,
                  { node: <span className="sub">{[...it.phrases.slice(0, 6), ...it.page_paths].join(' · ')}{it.phrases.length > 6 ? ` · +${it.phrases.length - 6} more` : ''}</span> },
                  { b: [it.is_active ? 'On' : 'Off', it.is_active ? 'b-green' : 'b-gray'] },
                  { node: (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button className="btn sm" disabled={busy} data-testid={`fb-scope-edit-${it.id}`}
                        onClick={() => { setErr(null); setEdit({ ...it, phrasesText: it.phrases.join('\n'), pathsText: it.page_paths.join('\n') }); }}><Ic k="pencil" />Edit</button>
                      <button className="btn sm" disabled={busy} data-testid={`fb-scope-toggle-${it.id}`} onClick={() => toggle(it)}>{it.is_active ? 'Switch off' : 'Switch on'}</button>
                    </span>
                  ) },
                ];
              })}
              empty={loading ? 'Loading…' : 'Nothing on the scope list.'} />
          )}
          {err && <div className="fb-error" style={{ marginTop: 10 }} data-testid="fb-scope-error">{err}</div>}
        </div>
        <div className="af">
          {edit ? (
            <>
              <button className="btn primary" disabled={busy} onClick={save} data-testid="fb-scope-save"><Ic k="save" />{edit.id ? 'Save changes' : 'Add to the scope list'}</button>
              <button className="btn" disabled={busy} onClick={() => { setEdit(null); setErr(null); }}>Back</button>
            </>
          ) : team ? (
            <button className="btn primary" onClick={() => { setErr(null); setEdit({ is_active: true, phrasesText: '', pathsText: '' }); }} data-testid="fb-scope-add"><Ic k="plus" />Add an item</button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
