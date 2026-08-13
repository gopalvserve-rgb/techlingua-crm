/**
 * CONVERT TO STUDENT — the shared modal used by the lead sheet AND the leads list (⋮).
 *
 * It is IDEMPOTENT by design: on open it asks the API whether this lead is already a
 * student and, if so, shows the existing record instead of offering to make a second one.
 * Converting POSTs /students/convert, which creates the student from the lead and moves
 * the lead to its pipeline's WON stage (server-side). A leaf module — imports nothing that
 * imports it — so both the sheet and the list can use it without an import cycle.
 */
import { useEffect, useState } from 'react';
import { api } from './api';
import { Ic } from './icons';
import { toast } from './refdata';

interface ExistingStudent { id: number; student_no: string; full_name: string; status: string }

export function ConvertStudentModal({ leadId, leadName, onDone, onClose }: {
  leadId: number; leadName?: string; onDone?: () => void; onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [existing, setExisting] = useState<ExistingStudent | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await api.get<{ student: ExistingStudent | null }>(`/students/by-lead/${leadId}`);
        if (live) setExisting(r?.student ?? null);
      } catch (e) { if (live) setErr((e as Error).message); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [leadId]);

  const convert = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post<{ student_no?: string; already?: boolean }>('/students/convert', { lead_id: leadId });
      toast(r?.already
        ? `Already a student (${r.student_no ?? ''})`
        : `Converted to student ${r?.student_no ?? ''} — lead marked WON`);
      onDone?.();
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 320 }}>
      <div className="add-modal" style={{ width: 440 }}>
        <div className="ah">
          <h3><Ic k="students" />Convert to Student</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>
          {loading ? (
            <div className="empty-note">Checking…</div>
          ) : existing ? (
            <div>
              <div className="notice" style={{ marginBottom: 10 }}>
                <Ic k="check" />
                <div><b>{existing.full_name}</b> is already a student
                  {' '}(<b className="mono">{existing.student_no}</b>, {existing.status}).
                  A lead converts to a student once.</div>
              </div>
            </div>
          ) : (
            <div>
              Convert <b>{leadName || 'this lead'}</b> to a student? This creates a student
              record from the lead (name, phone, email, branch, vertical, course, owner) and
              marks the lead as <b>WON</b>. If the lead has an enrolment, the student is linked to it.
            </div>
          )}
          {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>{existing ? 'Close' : 'Cancel'}</button>
          {!loading && !existing && (
            <button className="btn primary" disabled={busy} onClick={convert}>
              <Ic k="students" />{busy ? 'Converting…' : 'Convert to Student'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * BULK CONVERT TO STUDENTS — the Leads-list multi-select action.
 *
 * Confirms how many leads will be converted, then POSTs /students/bulk-convert { ids }.
 * The server reuses the SAME single-convert per lead (own transaction each) so mapping,
 * dedupe, scope and the lead-WIN side effect are identical to the one-at-a-time path;
 * each lead carries its OWN branch/vertical/course/owner (no shared picker needed). One
 * bad lead never rolls back the others. On completion it shows a per-lead summary
 * (converted / skipped "already converted" / failed with reason).
 */
interface BulkConvertResult {
  converted: Array<{ lead_id: number; student_id: number; student_no: string }>;
  skipped: Array<{ lead_id: number; reason: string; student_id?: number }>;
  failed: Array<{ lead_id: number; error: string }>;
  counts: { requested: number; converted: number; skipped: number; failed: number };
}

export function BulkConvertStudentsModal({ ids, onDone, onClose }: {
  ids: number[]; onDone?: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<BulkConvertResult | null>(null);

  const run = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post<BulkConvertResult>('/students/bulk-convert', { ids });
      setResult(r);
      const c = r?.counts;
      toast(`Converted ${c?.converted ?? 0} of ${c?.requested ?? ids.length} — `
        + `${c?.skipped ?? 0} skipped, ${c?.failed ?? 0} failed`, (c?.failed ?? 0) > 0);
      onDone?.();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim" style={{ zIndex: 320 }}>
      <div className="add-modal" style={{ width: 480 }}>
        <div className="ah">
          <h3><Ic k="students" />Convert to students</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody" style={{ fontSize: 13 }}>
          {!result ? (
            <div>
              Convert the <b>{ids.length}</b> selected lead{ids.length === 1 ? '' : 's'} to
              students? Each becomes a student record from its own lead (name, phone, email,
              branch, vertical, course, owner) and its lead is marked <b>WON</b>. Leads already
              converted are skipped (no duplicate student). Enrolments, if any, are linked.
            </div>
          ) : (
            <div data-testid="bulk-convert-result">
              <div className="notice" style={{ marginBottom: 10 }}>
                <Ic k="check" />
                <div><b>{result.counts.converted}</b> converted ·
                  {' '}<b>{result.counts.skipped}</b> skipped ·
                  {' '}<b>{result.counts.failed}</b> failed
                  {' '}(of {result.counts.requested}).</div>
              </div>
              {result.skipped.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 12 }}>Skipped</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {result.skipped.map((s) => (
                      <li key={s.lead_id}>Lead #{s.lead_id} — {s.reason}</li>
                    ))}
                  </ul>
                </div>
              )}
              {result.failed.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <b style={{ fontSize: 12, color: 'var(--red)' }}>Failed</b>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {result.failed.map((f) => (
                      <li key={f.lead_id}>Lead #{f.lead_id} — {f.error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {err && <div className="form-err" style={{ marginTop: 8 }}>{err}</div>}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
          {!result && (
            <button className="btn primary" disabled={busy} onClick={run}>
              <Ic k="students" />{busy ? 'Converting…' : `Convert ${ids.length} to students`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
