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
