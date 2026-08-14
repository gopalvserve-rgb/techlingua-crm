/**
 * SPRINT 5 — CONVERSION & MONEY-LITE.
 *
 * Performance & Conversion › Quotations · Sale Closure · Monthly Targets ·
 * Counsellor Performance, and Finance & Collections › Fee Collection (LITE).
 *
 * Every screen reuses the prototype's existing blocks (card, tbl, add-modal, form-grid,
 * kpi-strip, hbars) — no new visual language, per the project's design rule.
 *
 * WHAT THESE SCREENS DELIBERATELY DO NOT DO (Phase 3, and they SAY so on the face of the
 * screen rather than leaving the client to discover it):
 *   · no GST tax invoice — a quotation shows tax as a number, that is all;
 *   · no Razorpay capture — an "online" payment is one the client reconciled by hand;
 *   · no dues/ageing, no installment schedule, no refunds.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import { Ic } from './icons';
import { Cell, HBars, Kpis, TableCard } from './renderer';
import { toast, useFetch, useRef_ } from './refdata';
import { LeadLookup, MasterQuickAdd } from './forms';
import {
  DiscountType, LineDraft, computeTotals, fmtINR, minorToInput, parseRupees,
} from './money';
import { CONVERSION_LABEL_COUNSELLOR } from './metrics';
import { DateRange } from './daterange';

/* ==================================================================== */
/*  shared bits                                                          */
/* ==================================================================== */

const RowBtns = ({ items }: { items: Array<[string, string, () => void]> }) => (
  <div className="rowacts">
    {items.map(([icon, title, fn]) => (
      <button className="icon-btn sm" key={title} title={title}
        onClick={(e) => { e.stopPropagation(); fn(); }}>
        <Ic k={icon} />
      </button>
    ))}
  </div>
);

const badge = (k: string): Cell => {
  const map: Record<string, [string, string]> = {
    draft: ['Draft', 'b-gray'], sent: ['Sent', 'b-indigo'], accepted: ['Accepted', 'b-green'],
    rejected: ['Rejected', 'b-rose'], expired: ['Expired', 'b-amber'],
    active: ['Active', 'b-green'], pending_approval: ['Awaiting approval', 'b-amber'],
    cancelled: ['Cancelled', 'b-gray'], pending: ['Pending', 'b-amber'], approved: ['Approved', 'b-green'],
  };
  const [label, cls] = map[k] ?? [k, 'b-gray'];
  return { b: [label, cls] };
};

const dt = (v: unknown) => (v ? new Date(String(v)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Open a PDF the API streams. The route is permission-guarded server-side. */
const openPdf = (path: string) => { window.open(`/api${path}`, '_blank', 'noopener'); };

/** The amber note that keeps a Phase-1 screen honest about a Phase-3 gap. */
const PhaseNote = ({ children }: { children: React.ReactNode }) => (
  <div className="notice" style={{ marginBottom: 12 }}>
    <Ic k="bolt" /><div>{children}</div>
  </div>
);

/* ==================================================================== */
/*  QUOTATIONS                                                           */
/* ==================================================================== */

interface Quote {
  id: number; quote_no: string; version: number; status: string; valid_until: string | null;
  subtotal_minor: number; discount_minor: number; tax_minor: number; total_minor: number;
  created_at: string; lead_id: number; lead_name: string; lead_phone: string;
  branch_name: string; vertical_name: string; owner_name: string | null;
  course_names: string | null; item_count: number;
}

const emptyLine = (): LineDraft => ({
  course_id: null, description: '', qty: '1', unit_price: '',
  discount_type: 'amount', discount_value: '', tax_pct: '',
});

/**
 * A quotation form is opened in one of three modes. DEF-S16-01 existed because only two
 * of them had a door: `revise` was implemented end-to-end in the API and never rendered.
 */
export type QuoteMode = 'create' | 'edit' | 'revise';

/**
 * THE QUOTATION BUILDER.
 *
 * The totals under the lines are computed by `money.ts`, which mirrors the API's rules
 * exactly — and the API recomputes everything anyway, so a drift here can only ever show
 * a preview that the save corrects. `money.test.ts` pins both to the same example.
 */
export function QuotationModal({ initial, leadId, mode = 'edit', onClose, onSaved }: {
  initial?: any; leadId?: number; mode?: QuoteMode; onClose: () => void; onSaved?: () => void;
}) {
  const revising = mode === 'revise';
  const ref = useRef_();
  const [lead, setLead] = useState<number | undefined>(initial?.lead_id ?? leadId);
  const [leadLabel, setLeadLabel] = useState<string>(initial?.lead_name ?? '');
  const [validUntil, setValidUntil] = useState<string>(initial?.valid_until ? String(initial.valid_until).slice(0, 10) : '');
  const [notes, setNotes] = useState<string>(initial?.notes ?? '');
  const [terms, setTerms] = useState<string>(initial?.terms ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    initial?.items?.length
      ? initial.items.map((i: any) => ({
        course_id: i.course_id ?? null, description: i.description, qty: String(i.qty),
        unit_price: minorToInput(i.unit_price_minor),
        discount_type: i.discount_type as DiscountType,
        discount_value: i.discount_type === 'percent' ? String(Number(i.discount_value)) : minorToInput(i.discount_minor),
        tax_pct: Number(i.tax_pct) ? String(Number(i.tax_pct)) : '',
      }))
      : [emptyLine()],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const totals = useMemo(() => computeTotals(lines), [lines]);
  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  /** Picking a course fills the description and the rate from the Course master — the
   *  same `meta.fee` the lead sheet's fee auto-fetch reads. Both stay editable: a
   *  quotation that cannot deviate from the list price is not a quotation. */
  const pickCourse = (i: number, courseId: string) => {
    const c = ref.courses.find((x) => String(x.id) === courseId);
    const fee = (c?.meta as any)?.fee;
    setLine(i, {
      course_id: courseId ? Number(courseId) : null,
      description: c?.name ?? lines[i].description,
      unit_price: fee !== undefined && fee !== null && fee !== '' ? String(fee) : lines[i].unit_price,
    });
  };

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body = {
        lead_id: lead,
        valid_until: validUntil || null,
        notes: notes || null,
        terms: terms || null,
        items: lines.map((l) => ({
          course_id: l.course_id ?? null,
          description: l.description,
          qty: Number(l.qty || 1),
          unit_price: l.unit_price || '0',
          discount_type: l.discount_type,
          discount_value: l.discount_value || '0',
          tax_pct: l.tax_pct || '0',
        })),
      };
      /**
       * DEF-S16-01. Three verbs, one form — because a revision IS the quotation form,
       * with the parent's numbers already in it. The API decides what each one means:
       *   revise -> POST /revise  : a NEW version; v1 survives byte-identically.
       *   edit   -> PATCH /:id    : drafts only; the API refuses a sent quote.
       *   create -> POST          : a new quotation, a new number.
       * `lead_id` is deliberately NOT sent when revising — `revise()` inherits the
       * parent's lead and path and never re-derives them from a client payload, so a
       * revision cannot be moved to a different customer.
       */
      const r = revising
        ? await api.post(`/quotations/${initial.id}/revise`, { ...body, lead_id: undefined })
        : initial?.id
          ? await api.patch(`/quotations/${initial.id}`, body)
          : await api.post('/quotations', body);
      toast(revising
        ? `Revision ${(r as any)?.quote_no ?? ''} created as a draft`
        : initial?.id ? 'Quotation updated' : `Quotation ${(r as any)?.quote_no ?? ''} created`);
      onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 940 }}>
        <div className="ah">
          <h3>
            <Ic k={revising ? 'refresh' : initial?.id ? 'pencil' : 'plus'} />
            {revising ? `Revise ${initial.quote_no}` : initial?.id ? `Edit ${initial.quote_no}` : 'New quotation'}
          </h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="q-lead">Lead <span className="star">*</span></label>
              {revising
                ? <input id="q-lead" className="ainp" value={leadLabel} readOnly disabled />
                : <LeadLookup inputId="q-lead" value={leadLabel} onPick={(id, label) => { setLead(id); setLeadLabel(label); }} />}
              <div className="fhint">
                {revising
                  ? 'A revision stays with its own quotation\u2019s lead — the same customer, a new version. Quote somebody else and it is a new quotation, not a revision.'
                  : 'The branch, vertical, pipeline and campaign are taken from the lead — a quotation cannot contradict its own lead\u2019s path.'}
              </div>
            </div>
            <div className="fld">
              <label htmlFor="q-valid">Valid until</label>
              <input id="q-valid" className="ainp" type="date" value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)} />
              <div className="fhint">After this date a sent quotation expires by itself.</div>
            </div>
            <div className="fld">
              <label htmlFor="q-number">Number</label>
              <input id="q-number" className="ainp"
                value={revising ? `${String(initial.quote_no).replace(/-R\d+$/, '')}-R\u2026` : initial?.quote_no ?? 'Allocated on save'}
                readOnly disabled />
              <div className="fhint">
                {revising
                  ? `${initial.quote_no} keeps its number and its record. The revision is the same number with the next -R suffix, allocated on save.`
                  : 'From the numbering series for this branch / vertical.'}
              </div>
            </div>
          </div>

          {/* ---------------- LINE ITEMS ---------------- */}
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-head">
              <h3><Ic k="list" />Line items</h3>
              <button className="btn ghost sm" onClick={() => setLines((l) => [...l, emptyLine()])}>
                <Ic k="plus" />Add line
              </button>
            </div>
            <div className="card-pad">
              {lines.map((l, i) => (
                <div key={i} style={{ borderTop: i ? '1px solid var(--line)' : 'none', paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
                  <div className="form-grid">
                    <div className="fld">
                      <label htmlFor={`q-course-${i}`}>Course</label><MasterQuickAdd type="course" onAdded={(row) => setLine(i, { course_id: Number(row.id) })} />
                      <select id={`q-course-${i}`} className="ainp" value={l.course_id ?? ''}
                        onChange={(e) => pickCourse(i, e.target.value)}>
                        <option value="">Custom line (no course)</option>
                        {ref.courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                      <div className="fhint">Fills the description and the rate from the Course master. Both stay editable.</div>
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-desc-${i}`}>Description <span className="star">*</span></label>
                      <input id={`q-desc-${i}`} className="ainp" value={l.description}
                        onChange={(e) => setLine(i, { description: e.target.value })}
                        placeholder="What the customer is paying for" />
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-qty-${i}`}>Qty</label>
                      <input id={`q-qty-${i}`} className="ainp" type="number" min={1} value={l.qty}
                        onChange={(e) => setLine(i, { qty: e.target.value })} />
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-rate-${i}`}>Rate (₹) <span className="star">*</span></label>
                      <input id={`q-rate-${i}`} className="ainp" value={l.unit_price}
                        onChange={(e) => setLine(i, { unit_price: e.target.value })} placeholder="0.00" />
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-dtype-${i}`}>Discount type</label>
                      <select id={`q-dtype-${i}`} className="ainp" value={l.discount_type}
                        onChange={(e) => setLine(i, { discount_type: e.target.value as DiscountType })}>
                        <option value="amount">Amount (₹)</option>
                        <option value="percent">Percent (%)</option>
                      </select>
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-dval-${i}`}>Discount</label>
                      <input id={`q-dval-${i}`} className="ainp" value={l.discount_value}
                        onChange={(e) => setLine(i, { discount_value: e.target.value })}
                        placeholder={l.discount_type === 'percent' ? '10' : '0.00'} />
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-tax-${i}`}>Tax %</label>
                      <input id={`q-tax-${i}`} className="ainp" value={l.tax_pct}
                        onChange={(e) => setLine(i, { tax_pct: e.target.value })} placeholder="0" />
                      <div className="fhint">Shown on the quotation. A GST tax invoice is Phase 3.</div>
                    </div>
                    <div className="fld">
                      <label htmlFor={`q-linetotal-${i}`}>Line total</label>
                      <input id={`q-linetotal-${i}`} className="ainp mono" value={fmtINR(totals.lines[i]?.total_minor ?? 0)} readOnly disabled />
                      {lines.length > 1 && (
                        <button className="btn ghost sm" style={{ marginTop: 6 }}
                          onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                          <Ic k="trash" />Remove line
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---------------- TOTALS ---------------- */}
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-pad">
              <div style={{ maxWidth: 320, marginLeft: 'auto' }}>
                {([
                  ['Subtotal', totals.subtotal_minor, false],
                  ['Discount', -totals.discount_minor, false],
                  ['Tax', totals.tax_minor, false],
                  ['Total', totals.total_minor, true],
                ] as Array<[string, number, boolean]>).map(([lab, val, strong]) => (
                  <div key={lab} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: strong ? '1px solid var(--line)' : undefined, marginTop: strong ? 6 : 0, paddingTop: strong ? 8 : 4 }}>
                    <span className={strong ? '' : 'sub'} style={strong ? { fontWeight: 600 } : undefined}>{lab}</span>
                    <span className="mono" style={strong ? { fontWeight: 700 } : undefined}>{fmtINR(val)}</span>
                  </div>
                ))}
              </div>
              <div className="fhint" style={{ marginTop: 8 }}>
                Discount is applied before tax, per line, rounded to the paisa — so the Amount column always adds up to the Total.
              </div>
            </div>
          </div>

          {/* ---------------- NOTES ---------------- */}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <div className="fld span2">
              <label htmlFor="q-notes">Notes</label>
              <textarea id="q-notes" className="ainp" rows={2} value={notes}
                onChange={(e) => setNotes(e.target.value)} placeholder="Anything the customer should read on the quotation" />
            </div>
            <div className="fld span2">
              <label htmlFor="q-terms">Terms</label>
              <textarea id="q-terms" className="ainp" rows={2} value={terms}
                onChange={(e) => setTerms(e.target.value)} placeholder="e.g. 50% on enrolment, balance before the second module" />
            </div>
          </div>

          {totals.error ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{totals.error}</div></div> : null}
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {/* The verb matters: a revision does not "save changes" to the sent quote —
              * it leaves that quote exactly as the customer received it and creates the
              * next version alongside it. Saying "Save changes" here would describe the
              * one thing the API refuses to do. */}
            <Ic k="check" />{busy ? 'Saving…' : revising ? 'Create revision' : initial?.id ? 'Save changes' : 'Save quotation'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Send a quotation through the SPRINT-4 channels. Degrades cleanly and VISIBLY. */
export function SendQuoteModal({ quote, onClose, onSent }: { quote: any; onClose: () => void; onSent: () => void }) {
  const templates = useFetch<any[]>('/templates');
  const [channel, setChannel] = useState('email');
  const [templateId, setTemplateId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sent: boolean; reason?: string | null } | null>(null);

  const opts = (templates.data ?? []).filter((t) => t.channel === channel);

  const send = async () => {
    setBusy(true); setResult(null);
    try {
      const r = await api.post<{ sent: boolean; reason?: string | null }>(`/quotations/${quote.id}/send`, {
        channel, template_id: templateId ? Number(templateId) : undefined,
      });
      setResult(r);
      if (r.sent) { toast(`Quotation sent by ${channel}`); onSent(); }
    } catch (e) { setResult({ sent: false, reason: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 560 }}>
        <div className="ah">
          <h3><Ic k="send" />Send {quote.quote_no}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="sq-channel">Channel</label>
              <select id="sq-channel" className="ainp" value={channel}
                onChange={(e) => { setChannel(e.target.value); setTemplateId(''); }}>
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="sq-tpl">Template</label>
              <select id="sq-tpl" className="ainp" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">Default quotation message</option>
                {opts.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <div className="fhint">Uses the Sprint-4 templates, so merge variables and the send log behave as everywhere else.</div>
            </div>
          </div>
          <PhaseNote>
            The message links the customer to you, not to the PDF — file hosting (Cloudflare R2)
            is stored but not yet serving. Download the PDF and attach it, or send the link once R2 is cut over.
          </PhaseNote>
          {result && (
            <div className={`notice ${result.sent ? '' : 'err'}`} style={{ marginTop: 10 }}>
              <Ic k={result.sent ? 'check' : 'bolt'} />
              <div>
                {result.sent
                  ? `Sent by ${channel}. It is on the Send Log with its delivery status.`
                  : <>Not sent. <b>{result.reason}</b></>}
              </div>
            </div>
          )}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy} onClick={send}>
            <Ic k="send" />{busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "MARK AS SENT" — the offline despatch.
 *
 * THE LIVE SMOKE FOUND THE HOLE THIS FILLS: with no SMTP and no WhatsApp configured —
 * which is this client's system today — `Send` always fails, so a quotation could never
 * leave DRAFT, never be accepted, and never become an enrolment. The whole conversion
 * flow was blocked by a missing credential, which the project's own rule forbids.
 *
 * It is also just true to life: a counsellor prints the PDF and hands it across the desk.
 */
function MarkSentModal({ quote, onClose, onDone }: { quote: any; onClose: () => void; onDone: () => void }) {
  const [how, setHow] = useState('handed_over');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/quotations/${quote.id}/mark-sent`, { how }); toast('Marked as sent'); onDone(); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 520 }}>
        <div className="ah">
          <h3><Ic k="check" />Mark {quote.quote_no} as sent</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="ms-how">How did it reach the customer? <span className="star">*</span></label>
              <select id="ms-how" className="ainp" value={how} onChange={(e) => setHow(e.target.value)}>
                <option value="handed_over">I handed it over in person</option>
                <option value="emailed">I emailed it myself</option>
                <option value="whatsapp">I sent it on WhatsApp myself</option>
                <option value="other">Some other way</option>
              </select>
              <div className="fhint">
                Recorded on the lead's timeline. Use <b>Send</b> instead if you want the CRM to despatch it
                and track delivery — that needs the channel configured in Settings.
              </div>
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={go}><Ic k="check" />{busy ? 'Saving…' : 'Mark as sent'}</button>
        </div>
      </div>
    </div>
  );
}

/** The quotation sheet — lines, totals, revisions, and every action it can take. */
function QuoteDetail({ id, onClose, onChanged, onEnrol }: {
  id: number; onClose: () => void; onChanged: () => void; onEnrol: (prefill: any) => void;
}) {
  const { data, reload } = useFetch<any>(`/quotations/${id}`);
  const { can } = useAuth();
  const [send, setSend] = useState(false);
  const [markSent, setMarkSent] = useState(false);
  const [edit, setEdit] = useState<QuoteMode | null>(null);
  const [busy, setBusy] = useState(false);
  const q = data;
  if (!q) return null;

  const act = async (path: string, msg: string) => {
    setBusy(true);
    try { await api.post(`/quotations/${id}/${path}`, {}); toast(msg); reload(); onChanged(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };

  const convert = async () => {
    try {
      const prefill = await api.get<any>(`/quotations/${id}/convert-preview`);
      onEnrol(prefill);
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 860 }}>
        <div className="ah">
          <h3><Ic k="doc" />{q.quote_no}{q.version > 1 ? ` · Revision ${q.version}` : ''}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
            {([['Status', ''], ['Lead', q.lead_name], ['Valid until', dt(q.valid_until)], ['Total', fmtINR(q.total_minor)]] as Array<[string, string]>)
              .map(([lab, val], i) => (
                <div className="card kpi" key={lab}>
                  <div className="lab">{lab}</div>
                  <div className="val" style={{ fontSize: i === 0 ? 14 : undefined }}>
                    {i === 0 ? <span className={`bdg ${(badge(q.status) as any).b[1]}`}>{(badge(q.status) as any).b[0]}</span> : val}
                  </div>
                </div>
              ))}
          </div>

          <TableCard
            title="Line items" icon="list"
            cols={['#', 'Description', 'Qty', 'Rate', 'Discount', 'Tax', 'Amount']}
            rows={(q.items ?? []).map((i: any): Cell[] => [
              String(i.line_no),
              { node: <div><b>{i.description}</b>{i.course_name ? <div className="sub">{i.course_name}</div> : null}</div> },
              String(i.qty),
              { mono: fmtINR(i.unit_price_minor) },
              { mono: Number(i.discount_minor) ? `${i.discount_type === 'percent' ? `${Number(i.discount_value)}% · ` : ''}${fmtINR(i.discount_minor)}` : '—' },
              { mono: Number(i.tax_pct) ? `${Number(i.tax_pct)}% · ${fmtINR(i.tax_minor)}` : '—' },
              { mono: fmtINR(i.total_minor) },
            ])}
          />

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-pad">
              <div style={{ maxWidth: 300, marginLeft: 'auto' }}>
                {([['Subtotal', q.subtotal_minor], ['Discount', -q.discount_minor], ['Tax', q.tax_minor]] as Array<[string, number]>)
                  .map(([lab, v]) => (
                    <div key={lab} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                      <span className="sub">{lab}</span><span className="mono">{fmtINR(v)}</span>
                    </div>
                  ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 8, fontWeight: 700 }}>
                  <span>Total</span><span className="mono">{fmtINR(q.total_minor)}</span>
                </div>
              </div>
            </div>
          </div>

          {(q.versions ?? []).length > 1 && (
            <TableCard
              title="Revisions" icon="refresh" cols={['Version', 'Number', 'Status', 'Total', 'Created', '']}
              rows={(q.versions ?? []).map((v: any): Cell[] => [
                `v${v.version}`, { mono: v.quote_no }, badge(v.status), { mono: fmtINR(v.total_minor) }, dt(v.created_at),
                v.is_current ? { b: ['Current', 'b-green'] } : '',
              ])}
            />
          )}

          {q.notes ? <div className="card" style={{ marginTop: 12 }}><div className="card-pad"><div className="sub">Notes</div><div>{q.notes}</div></div></div> : null}
          {q.terms ? <div className="card" style={{ marginTop: 12 }}><div className="card-pad"><div className="sub">Terms</div><div>{q.terms}</div></div></div> : null}

          {q.status === 'accepted' && (
            <PhaseNote>
              <b>Convert to enrolment</b> creates the sale-closure record this quotation becomes.
              A <b>GST tax invoice</b> — with HSN/SAC, CGST/SGST/IGST and place of supply — is Phase 3,
              and will be raised from that enrolment.
            </PhaseNote>
          )}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn ghost" onClick={() => openPdf(`/quotations/${id}/pdf`)}><Ic k="doc" />PDF</button>
          {q.status === 'draft' && can('quotation.update') && (
            <button className="btn ghost" onClick={() => setEdit('edit')}><Ic k="pencil" />Edit</button>
          )}
          {/*
            * DEF-S16-01 — THE DOOR.
            *
            * `revise()` has been complete and correct in the API since Sprint 5 and
            * nothing in `web/src` ever called it. The API refuses to edit a sent quote
            * with the words "create a revision instead" — and there was no Revise button
            * to press, so a sent quotation whose price had to change was a DEAD END: the
            * counsellor's only exits were Accept, Reject, or build a new quotation from
            * scratch, which takes a new number and breaks the version chain that is the
            * whole point of the feature. Renegotiating a price is the normal case.
            *
            * `quotation.create` is the permission because a revision IS a creation — it
            * is what the API's own @RequirePermission on POST /:id/revise asks for, and
            * these two must not drift (a button that 403s is worse than no button).
            *
            * `route-reachability.spec.ts` now fails the build if any route loses its
            * caller, so this class of defect cannot ship silently again.
            */}
          {q.status === 'sent' && can('quotation.create') && (
            <button className="btn ghost" disabled={busy} onClick={() => setEdit('revise')}>
              <Ic k="refresh" />Revise
            </button>
          )}
          {['draft', 'sent'].includes(q.status) && can('quotation.send') && (
            <button className="btn ghost" onClick={() => setSend(true)}><Ic k="send" />Send</button>
          )}
          {q.status === 'draft' && can('quotation.send') && (
            <button className="btn ghost" onClick={() => setMarkSent(true)}><Ic k="check" />Mark as sent</button>
          )}
          {q.status === 'sent' && can('quotation.update') && (
            <>
              <button className="btn ghost" disabled={busy} onClick={() => void act('reject', 'Marked rejected')}><Ic k="x" />Rejected</button>
              <button className="btn primary" disabled={busy} onClick={() => void act('accept', 'Marked accepted')}><Ic k="check" />Accepted</button>
            </>
          )}
          {q.status === 'accepted' && can('enrolment.create') && (
            <button className="btn primary" onClick={() => void convert()}><Ic k="check" />Convert to enrolment</button>
          )}
        </div>
      </div>
      {send && <SendQuoteModal quote={q} onClose={() => setSend(false)} onSent={() => { reload(); onChanged(); }} />}
      {markSent && <MarkSentModal quote={q} onClose={() => setMarkSent(false)} onDone={() => { reload(); onChanged(); }} />}
      {edit && (
        <QuotationModal initial={q} mode={edit} onClose={() => setEdit(null)}
          onSaved={() => { reload(); onChanged(); }} />
      )}
    </div>
  );
}

export function Quotations() {
  const { can } = useAuth();
  const { data, reload } = useFetch<Quote[]>('/quotations');
  const summary = useFetch<any>('/quotations/summary');
  const [modal, setModal] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [enrolPrefill, setEnrolPrefill] = useState<any>(null);
  const rows = data ?? [];
  const s = summary.data;

  const bump = () => { reload(); summary.reload(); };

  return (
    <>
      {can('quotation.create') && (
        <div className="page-actions">
          <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New quotation</button>
        </div>
      )}
      <Kpis items={[
        { lab: 'Open (sent)', val: String(s?.sent ?? 0), ic: 'send' },
        { lab: 'Accepted', val: String(s?.accepted ?? 0), ic: 'check' },
        { lab: 'Value accepted', val: s ? fmtINR(s.accepted_minor) : '—', ic: 'rupee' },
        { lab: 'Value in play', val: s ? fmtINR(s.open_minor) : '—', ic: 'perf' },
      ]} />
      <TableCard
        title="Quotations" icon="doc"
        cols={['Quote #', 'Lead', 'Course', 'Amount', 'Validity', 'Status', '']}
        empty="No quotations yet — create one from a lead to price a course and send it."
        onRowClick={(i) => setOpenId(rows[i].id)}
        rows={rows.map((q): Cell[] => [
          { node: <div><b className="mono">{q.quote_no}</b>{q.version > 1 ? <div className="sub">Revision {q.version}</div> : null}</div> },
          { node: <div><b>{q.lead_name}</b><div className="sub mono">{q.lead_phone}</div></div> },
          q.course_names || `${q.item_count} line${Number(q.item_count) === 1 ? '' : 's'}`,
          { mono: fmtINR(q.total_minor) },
          q.valid_until ? dt(q.valid_until) : '—',
          badge(q.status),
          { node: <RowBtns items={[['doc', 'PDF', () => openPdf(`/quotations/${q.id}/pdf`)]]} /> },
        ])}
      />
      {modal && <QuotationModal onClose={() => setModal(false)} onSaved={bump} />}
      {openId && (
        <QuoteDetail id={openId} onClose={() => setOpenId(null)} onChanged={bump}
          onEnrol={(p) => { setOpenId(null); setEnrolPrefill(p); }} />
      )}
      {enrolPrefill && (
        <EnrolmentModal prefill={enrolPrefill} onClose={() => setEnrolPrefill(null)}
          onSaved={() => { setEnrolPrefill(null); bump(); }} />
      )}
    </>
  );
}

/* ==================================================================== */
/*  SALE CLOSURE — enrolments + the approval queue                       */
/* ==================================================================== */

/**
 * THE CLOSURE FORM.
 *
 * `Net fee` is DERIVED and read-only — the client never types a net that could disagree
 * with its own fee and discount, and the API recomputes it regardless.
 */
export function EnrolmentModal({ initial, prefill, onClose, onSaved }: {
  initial?: any; prefill?: any; onClose: () => void; onSaved?: () => void;
}) {
  const ref = useRef_();
  const meta = useFetch<any>('/enrolments/meta');
  const [lead, setLead] = useState<number | undefined>(initial?.lead_id ?? prefill?.lead_id);
  const [leadLabel, setLeadLabel] = useState<string>(initial?.lead_name ?? prefill?.lead_name ?? '');
  const [courseId, setCourseId] = useState<string>(String(initial?.course_id ?? prefill?.course_id ?? ''));
  const [fee, setFee] = useState<string>(minorToInput(initial?.fee_minor ?? prefill?.fee_minor));
  const [discount, setDiscount] = useState<string>(minorToInput(initial?.discount_minor ?? prefill?.discount_minor));
  const [plan, setPlan] = useState<string>(initial?.payment_plan ?? 'full');
  const [firstPayment, setFirstPayment] = useState<string>(minorToInput(initial?.first_payment_minor));
  const [planNote, setPlanNote] = useState<string>(initial?.plan_note ?? '');
  const [startDate, setStartDate] = useState<string>(initial?.start_date ? String(initial.start_date).slice(0, 10) : '');
  const [counsellor, setCounsellor] = useState<string>(String(initial?.counsellor_id ?? prefill?.counsellor_id ?? ''));
  const [remarks, setRemarks] = useState<string>(initial?.remarks ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const feeMinor = parseRupees(fee);
  const discMinor = parseRupees(discount);
  const netMinor = feeMinor !== null && discMinor !== null ? Math.max(0, feeMinor - discMinor) : 0;
  const approvals = meta.data?.approvals;

  /** Picking a course fills the fee from the Course master — the same meta.fee the lead
   *  sheet reads. Editable, because a closure is where a discount actually happens. */
  const pickCourse = (id: string) => {
    setCourseId(id);
    const c = ref.courses.find((x) => String(x.id) === id);
    const f = (c?.meta as any)?.fee;
    if (f !== undefined && f !== null && f !== '' && !fee) setFee(String(f));
  };

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body = {
        lead_id: lead,
        quotation_id: prefill?.quotation_id ?? undefined,
        course_id: courseId ? Number(courseId) : null,
        fee: fee || '0',
        discount: discount || '0',
        payment_plan: plan,
        first_payment: firstPayment || '0',
        plan_note: planNote || null,
        start_date: startDate || null,
        counsellor_id: counsellor ? Number(counsellor) : null,
        remarks: remarks || null,
      };
      const r = initial?.id
        ? await api.patch(`/enrolments/${initial.id}`, body)
        : await api.post('/enrolments', body);
      const res = r as any;
      toast(res?.status === 'pending_approval'
        ? `${res.enrolment_no} submitted for approval`
        : initial?.id ? 'Enrolment updated' : `Enrolled — ${res?.enrolment_no ?? ''}`);
      onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 820 }}>
        <div className="ah">
          <h3><Ic k={initial?.id ? 'pencil' : 'check'} />{initial?.id ? `Edit ${initial.enrolment_no}` : 'Close the sale — new enrolment'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          {prefill?.quote_no && (
            <div className="notice" style={{ marginBottom: 12 }}>
              <Ic k="doc" /><div>Converted from quotation <b>{prefill.quote_no}</b>. Tax is not carried across — a GST invoice is Phase 3.</div>
            </div>
          )}
          {approvals?.enabled && !initial?.id && (
            <div className="notice" style={{ marginBottom: 12 }}>
              <Ic k="clock" />
              <div>
                Approvals are ON. This enrolment will go to the approval queue
                ({approvals.steps.map((s: any) => s.label).join(' · ')}) and will not count towards
                targets or revenue, or accept a fee, until it is approved.
              </div>
            </div>
          )}
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="e-lead">Lead <span className="star">*</span></label>
              {initial?.id
                ? <input id="e-lead" className="ainp" value={leadLabel} readOnly disabled />
                : <LeadLookup inputId="e-lead" value={leadLabel} onPick={(id, label) => { setLead(id); setLeadLabel(label); }} />}
              <div className="fhint">Branch, vertical and campaign come from the lead. Closing the sale moves the lead to its pipeline's Won stage.</div>
            </div>
            <div className="fld">
              <label htmlFor="e-course">Course</label><MasterQuickAdd type="course" onAdded={(row) => setCourseId(String(row.id))} />
              <select id="e-course" className="ainp" value={courseId} onChange={(e) => pickCourse(e.target.value)}>
                <option value="">—</option>
                {ref.courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <div className="fhint">Fee auto-fills from the Course master.</div>
            </div>
            <div className="fld">
              <label htmlFor="e-counsellor">Counsellor</label>
              <select id="e-counsellor" className="ainp" value={counsellor} onChange={(e) => setCounsellor(e.target.value)}>
                <option value="">Lead owner</option>
                {ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <div className="fhint">Who this admission counts for on the leaderboard and against a target.</div>
            </div>
            <div className="fld">
              <label htmlFor="e-fee">Total fee (₹) <span className="star">*</span></label>
              <input id="e-fee" className="ainp" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0.00" />
            </div>
            <div className="fld">
              <label htmlFor="e-discount">Discount (₹)</label>
              <input id="e-discount" className="ainp" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0.00" />
              {approvals?.enabled && approvals.steps.some((s: any) => s.key === 'discount')
                ? <div className="fhint">A discount above the configured threshold needs a manager's approval.</div> : null}
            </div>
            <div className="fld">
              <label htmlFor="e-net">Net fee</label>
              <input id="e-net" className="ainp mono" value={fmtINR(netMinor)} readOnly disabled />
              <div className="fhint">Total fee less discount. Derived — never typed, so it cannot disagree with itself.</div>
            </div>
            <div className="fld">
              <label htmlFor="e-plan">Payment plan</label>
              <select id="e-plan" className="ainp" value={plan} onChange={(e) => setPlan(e.target.value)}>
                {(meta.data?.payment_plans ?? [{ key: 'full', label: 'Full payment' }]).map((p: any) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              <div className="fhint">What was agreed at the desk. The installment SCHEDULE, dues and reminders are Phase 3.</div>
            </div>
            <div className="fld">
              <label htmlFor="e-first">First payment (₹)</label>
              <input id="e-first" className="ainp" value={firstPayment} onChange={(e) => setFirstPayment(e.target.value)} placeholder="0.00" />
              <div className="fhint">Intent. Record the money itself on Fee Collection.</div>
            </div>
            <div className="fld">
              <label htmlFor="e-start">Start date</label>
              <input id="e-start" className="ainp" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="e-plannote">Plan note</label>
              <input id="e-plannote" className="ainp" value={planNote} onChange={(e) => setPlanNote(e.target.value)}
                placeholder="e.g. 3 x ₹15,000 on the 5th" />
            </div>
            <div className="fld span2">
              <label htmlFor="e-remarks">Remarks</label>
              <textarea id="e-remarks" className="ainp" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            <Ic k="check" />{busy ? 'Saving…' : initial?.id ? 'Save changes' : approvals?.enabled ? 'Submit for approval' : 'Enrol'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SaleClosure() {
  const { can } = useAuth();
  // SHARED date range on the enrolment date (created_at). Default All time so nothing is hidden.
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const eq = new URLSearchParams();
  if (range.from) eq.set('from', range.from);
  if (range.to) eq.set('to', range.to);
  const rangeKey = `${range.from ?? ''}~${range.to ?? ''}`;
  const { data, reload } = useFetch<any[]>('/enrolments' + (eq.toString() ? `?${eq}` : ''), [rangeKey]);
  const summary = useFetch<any>('/enrolments/summary');
  const queue = useFetch<any[]>(can('enrolment.approve') ? '/enrolments/approvals?status=pending' : null);
  const policy = useFetch<any>('/enrolments/approval-policy');
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const rows = data ?? [];
  const s = summary.data;

  const bump = () => { reload(); summary.reload(); queue.reload(); };

  const decide = async (id: number, approve: boolean) => {
    try {
      await api.post(`/enrolments/approvals/${id}/${approve ? 'approve' : 'reject'}`, {});
      toast(approve ? 'Approved' : 'Rejected'); bump();
    } catch (e) { toast((e as Error).message); }
  };

  return (
    <>
      {can('enrolment.create') && (
        <div className="page-actions">
          <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />New enrolment</button>
        </div>
      )}
      <Kpis items={[
        { lab: 'Enrolments (MTD)', val: String(s?.mtd_count ?? 0), ic: 'check' },
        { lab: 'Revenue closed (MTD)', val: s ? fmtINR(s.mtd_revenue_minor) : '—', ic: 'rupee' },
        { lab: 'Avg discount', val: s ? `${s.avg_discount_pct}%` : '—', ic: 'perf' },
        { lab: 'Pending approval', val: String(s?.pending_approval ?? 0), ic: 'clock' },
      ]} />

      <div className="filters" style={{ marginBottom: 12 }}>
        <DateRange value={range} onChange={setRange} idPrefix="enrol-dr" />
      </div>

      {policy.data && !policy.data.enabled ? (
        <PhaseNote>
          Approvals are <b>off</b>: a counsellor closes a sale and it is closed.
          Switch them on per step in <b>Administration › Settings › Enrolment approvals</b> — no deploy.
        </PhaseNote>
      ) : null}

      {can('enrolment.approve') && (queue.data ?? []).length > 0 && (
        <TableCard
          title="Awaiting your approval" icon="clock"
          cols={['Enrolment', 'Lead', 'Course', 'Net fee', 'Step', 'Requested by', '']}
          rows={(queue.data ?? []).map((a): Cell[] => [
            { mono: a.enrolment_no }, a.lead_name, a.course_name ?? '—',
            { mono: fmtINR(a.net_fee_minor) }, a.step_label, a.requested_by_name ?? '—',
            {
              node: <RowBtns items={[
                ['check', 'Approve', () => void decide(a.id, true)],
                ['x', 'Reject', () => void decide(a.id, false)],
              ]} />,
            },
          ])}
        />
      )}

      <TableCard
        title="Enrolments" icon="students"
        cols={['Enrolment #', 'Lead', 'Course', 'Net fee', 'Collected', 'Balance', 'Plan', 'Status', '']}
        empty="No enrolments yet — close a sale from a lead, or convert an accepted quotation."
        rows={rows.map((e): Cell[] => [
          { node: <div><b className="mono">{e.enrolment_no}</b>{e.quote_no ? <div className="sub mono">{e.quote_no}</div> : null}</div> },
          { node: <div><b>{e.lead_name}</b><div className="sub mono">{e.lead_phone}</div></div> },
          e.course_name ?? '—',
          { mono: fmtINR(e.net_fee_minor) },
          { mono: fmtINR(e.paid_minor) },
          { mono: fmtINR(e.balance_minor), dim: Number(e.balance_minor) === 0 },
          e.payment_plan === 'full' ? 'Full' : e.payment_plan === 'emi_3' ? '3 EMI' : e.payment_plan === 'emi_6' ? '6 EMI' : 'Custom',
          badge(e.status),
          { node: can('enrolment.update') ? <RowBtns items={[['pencil', 'Edit', () => setEdit(e)]]} /> : '' },
        ])}
      />
      {modal && <EnrolmentModal onClose={() => setModal(false)} onSaved={bump} />}
      {edit && <EnrolmentModal initial={edit} onClose={() => setEdit(null)} onSaved={bump} />}
    </>
  );
}

/* ==================================================================== */
/*  MONTHLY TARGETS                                                      */
/* ==================================================================== */

export function TargetModal({ initial, onClose, onSaved }: {
  initial?: any; onClose: () => void; onSaved?: () => void;
}) {
  const ref = useRef_();
  const now = new Date();
  const [period, setPeriod] = useState<string>(
    initial?.period ? String(initial.period).slice(0, 7) : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  );
  const [scopeType, setScopeType] = useState<string>(initial?.scope_type ?? 'user');
  const [userId, setUserId] = useState<string>(String(initial?.user_id ?? ''));
  const [branchId, setBranchId] = useState<string>(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState<string>(String(initial?.vertical_id ?? ''));
  const [enrolTarget, setEnrolTarget] = useState<string>(String(initial?.enrolment_target ?? ''));
  const [revTarget, setRevTarget] = useState<string>(minorToInput(initial?.revenue_target_minor));
  const [note, setNote] = useState<string>(initial?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/performance/targets', {
        period,
        scope_type: scopeType,
        user_id: scopeType === 'user' ? Number(userId) || null : null,
        branch_id: scopeType === 'branch' ? Number(branchId) || null : null,
        vertical_id: scopeType === 'vertical' ? Number(verticalId) || null : null,
        enrolment_target: Number(enrolTarget || 0),
        revenue_target: revTarget || '0',
        note: note || null,
      });
      toast('Target saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah">
          <h3><Ic k="target" />{initial ? 'Edit target' : 'Set a monthly target'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="t-period">Month <span className="star">*</span></label>
              <input id="t-period" className="ainp" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="t-scope">Target for <span className="star">*</span></label>
              <select id="t-scope" className="ainp" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
                <option value="user">A counsellor</option>
                <option value="branch">A branch</option>
                <option value="vertical">A vertical</option>
              </select>
            </div>
            {scopeType === 'user' && (
              <div className="fld">
                <label htmlFor="t-user">Counsellor <span className="star">*</span></label>
                <select id="t-user" className="ainp" value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">—</option>
                  {ref.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            )}
            {scopeType === 'branch' && (
              <div className="fld">
                <label htmlFor="t-branch">Branch <span className="star">*</span></label>
                <select id="t-branch" className="ainp" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">—</option>
                  {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            )}
            {scopeType === 'vertical' && (
              <div className="fld">
                <label htmlFor="t-vertical">Vertical <span className="star">*</span></label>
                <select id="t-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                  <option value="">—</option>
                  {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
            )}
            <div className="fld">
              <label htmlFor="t-enrol">Admissions target</label>
              <input id="t-enrol" className="ainp" type="number" min={0} value={enrolTarget}
                onChange={(e) => setEnrolTarget(e.target.value)} placeholder="0" />
            </div>
            <div className="fld">
              <label htmlFor="t-rev">Revenue target (₹)</label>
              <input id="t-rev" className="ainp" value={revTarget} onChange={(e) => setRevTarget(e.target.value)} placeholder="0.00" />
              <div className="fhint">Measured on BOOKED revenue — the net fee of approved enrolments closed this month, not cash collected.</div>
            </div>
            <div className="fld span2">
              <label htmlFor="t-note">Note</label>
              <input id="t-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save target'}</button>
        </div>
      </div>
    </div>
  );
}

const barColor = (p: number) => (p >= 100 ? 'var(--green)' : p >= 60 ? 'var(--indigo)' : p >= 30 ? 'var(--amber)' : 'var(--rose)');

export function MonthlyTargets() {
  const { can } = useAuth();
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  const { data, reload } = useFetch<any[]>(`/performance/targets?period=${period}`, [period]);
  const [modal, setModal] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const rows = data ?? [];

  const del = async (t: any) => {
    if (!confirm(`Delete the ${period} target for ${t.label}?`)) return;
    try { await api.del(`/performance/targets/${t.id}`); toast('Target deleted'); reload(); }
    catch (e) { toast((e as Error).message); }
  };

  const branchBars = rows.filter((r) => r.scope_type !== 'user').map((r) => ({
    label: `${r.label} — ${r.actual_enrolments}/${r.enrolment_target} admissions`,
    val: `${r.enrolment_pct}%`,
    pct: Math.min(100, r.enrolment_pct),
    color: barColor(r.enrolment_pct),
  }));

  return (
    <>
      <div className="page-actions">
        <div className="fchip">
          <Ic k="cal" />
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month"
            style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} />
        </div>
        {can('target.manage') && (
          <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />Set a target</button>
        )}
      </div>
      <HBars title="Branch & vertical targets" rows={branchBars}
        empty="Branch targets appear once monthly targets are set" />
      <TableCard
        title="Counsellor targets" icon="target"
        cols={['Counsellor', 'Admissions target', 'Achieved', 'Revenue target', 'Achieved', '%', '']}
        empty="No targets set yet"
        rows={rows.filter((r) => r.scope_type === 'user').map((r): Cell[] => [
          r.label,
          String(r.enrolment_target),
          String(r.actual_enrolments),
          { mono: fmtINR(r.revenue_target_minor) },
          { mono: fmtINR(r.actual_revenue_minor) },
          { b: [`${r.enrolment_pct}%`, r.enrolment_pct >= 100 ? 'b-green' : r.enrolment_pct >= 60 ? 'b-indigo' : 'b-amber'] },
          {
            node: can('target.manage')
              ? <RowBtns items={[['pencil', 'Edit', () => setEdit(r)], ['trash', 'Delete', () => void del(r)]]} />
              : '',
          },
        ])}
      />
      {modal && <TargetModal onClose={() => setModal(false)} onSaved={reload} />}
      {edit && <TargetModal initial={edit} onClose={() => setEdit(null)} onSaved={reload} />}
    </>
  );
}

/* ==================================================================== */
/*  COUNSELLOR PERFORMANCE                                               */
/* ==================================================================== */

export function CounsellorPerformance() {
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const [range, setRange] = useState({ from: first, to: '' });
  const qs = `from=${range.from}${range.to ? `&to=${range.to}` : ''}`;
  const { data } = useFetch<any[]>(`/performance/leaderboard?${qs}`, [qs]);
  const summary = useFetch<any>(`/performance/summary?${qs}`, [qs]);
  const rows = data ?? [];
  const s = summary.data;

  const tat = (m: number | null) => (m === null ? '—' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`);

  return (
    <>
      <div className="page-actions">
        <div className="fchip"><Ic k="cal" />
          <input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            aria-label="From" style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} />
        </div>
        <div className="fchip"><Ic k="cal" />
          <input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            aria-label="To" style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} />
        </div>
      </div>
      <Kpis items={[
        { lab: 'Leads', val: String(s?.leads ?? 0), ic: 'leads' },
        { lab: 'Enrolments', val: String(s?.enrolments ?? 0), ic: 'check' },
        // OBS-S16-05: this is NOT the funnel's conversion and must not share its name —
        // the denominator is the counsellor's OWN leads. QA-16 saw 50% and 100% at the
        // same moment, both captioned "Conversion".
        { lab: CONVERSION_LABEL_COUNSELLOR, val: s ? `${s.conversion_pct}%` : '—', ic: 'target' },
        { lab: 'Revenue booked', val: s ? fmtINR(s.revenue_minor) : '—', ic: 'rupee' },
      ]} />
      <TableCard
        title="Leaderboard" icon="perf"
        cols={['#', 'Counsellor', 'Leads', 'Activity', 'Conv%', 'Enrol', 'Revenue booked', 'Collected', 'TAT', 'Adherence']}
        empty="Leaderboard fills as leads & closures accumulate"
        rows={rows.map((r, i): Cell[] => [
          String(i + 1),
          { node: <b>{r.user_name}</b> },
          String(r.leads),
          String(r.activities),
          { b: [`${r.conversion_pct}%`, r.conversion_pct >= 20 ? 'b-green' : r.conversion_pct >= 10 ? 'b-indigo' : 'b-gray'] },
          String(r.enrolments),
          { mono: fmtINR(r.revenue_minor) },
          { mono: fmtINR(r.collected_minor) },
          tat(r.tat_median_minutes),
          r.adherence_pct === null ? '—' : `${r.adherence_pct}%`,
        ])}
      />
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-pad">
          <div className="sub" style={{ marginTop: 0 }}>
            <b>Activity</b> counts timeline events logged (dispositions, follow-ups, notes) — telephony is out of scope,
            so this is not a call count and is not labelled as one.
            <b> Revenue booked</b> is the net fee of approved enrolments closed in the range; <b>Collected</b> is cash actually receipted.
            They are different numbers and are shown separately on purpose.
            <b> TAT</b> is the median first-response time from the SLA clock. <b>Adherence</b> is follow-ups completed on time.
          </div>
        </div>
      </div>
    </>
  );
}

/* ==================================================================== */
/*  FEE COLLECTION — LITE                                                */
/* ==================================================================== */

export function CollectModal({ enrolmentId, onClose, onSaved }: {
  enrolmentId?: number; onClose: () => void; onSaved?: () => void;
}) {
  const enrolments = useFetch<any[]>('/enrolments?status=active');
  const meta = useFetch<any>('/fees/meta');
  const [enrolment, setEnrolment] = useState<string>(String(enrolmentId ?? ''));
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState('cash');
  const [reference, setReference] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const list = enrolments.data ?? [];
  const chosen = list.find((e) => String(e.id) === enrolment);
  const needsRef = ['cheque', 'upi', 'online'].includes(mode);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.post<any>('/fees/collect', {
        enrolment_id: Number(enrolment),
        amount,
        mode,
        reference: reference || null,
        received_at: receivedAt ? new Date(`${receivedAt}T${new Date().toISOString().slice(11, 19)}Z`).toISOString() : undefined,
        note: note || null,
      });
      toast(`Receipt ${r.receipt_no} — ${r.fully_paid ? 'paid in full' : `${fmtINR(r.balance_minor)} outstanding`}`);
      onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 620 }}>
        <div className="ah">
          <h3><Ic k="rupee" />Record a payment</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld span2">
              <label htmlFor="c-enrolment">Enrolment <span className="star">*</span></label>
              <select id="c-enrolment" className="ainp" value={enrolment} onChange={(e) => setEnrolment(e.target.value)}>
                <option value="">—</option>
                {list.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.enrolment_no} · {e.lead_name}{e.course_name ? ` · ${e.course_name}` : ''} — {fmtINR(e.balance_minor)} due
                  </option>
                ))}
              </select>
              {chosen ? (
                <div className="fhint">
                  Net fee {fmtINR(chosen.net_fee_minor)} · paid {fmtINR(chosen.paid_minor)} ·
                  <b> outstanding {fmtINR(chosen.balance_minor)}</b>. More than the outstanding balance is refused.
                </div>
              ) : <div className="fhint">Only APPROVED, active enrolments can take money.</div>}
            </div>
            <div className="fld">
              <label htmlFor="c-amount">Amount (₹) <span className="star">*</span></label>
              <input id="c-amount" className="ainp" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              <div className="fhint">Partial payments are fine.</div>
            </div>
            <div className="fld">
              <label htmlFor="c-mode">Mode <span className="star">*</span></label>
              <select id="c-mode" className="ainp" value={mode} onChange={(e) => setMode(e.target.value)}>
                {(meta.data?.modes ?? [
                  { key: 'cash', label: 'Cash' }, { key: 'upi', label: 'UPI' }, { key: 'card', label: 'Card' },
                  { key: 'cheque', label: 'Cheque' }, { key: 'online', label: 'Online transfer' },
                ]).map((m: any) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="c-ref">Reference{needsRef ? <span className="star">*</span> : null}</label>
              <input id="c-ref" className="ainp" value={reference} onChange={(e) => setReference(e.target.value)}
                placeholder="UTR / cheque number" />
              {needsRef ? <div className="fhint">Required for {mode} — a receipt nobody can reconcile is a rumour.</div> : null}
            </div>
            <div className="fld">
              <label htmlFor="c-date">Received on</label>
              <input id="c-date" className="ainp" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </div>
            <div className="fld span2">
              <label htmlFor="c-note">Note</label>
              <input id="c-note" className="ainp" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          {meta.data?.online && (
            <PhaseNote>
              <b>Online capture (Razorpay) is Phase 3.</b> The keys are already stored per vertical — nothing is waiting on you.
              Until then record an online payment by hand, with its UTR.
            </PhaseNote>
          )}
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Record payment'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * FEE RECEIPT — a read-only details popup (client feedback item 5, the "View" action on the
 * Fee Receipt Records list). Shows the receipt with its Branch > Vertical > Course path; the
 * PDF is downloaded from the separate "Download receipt PDF" action (R2/streamed by the API).
 */
export function ReceiptViewModal({ r, onClose }: { r: any; onClose: () => void }) {
  const path = [r.branch_name, r.vertical_name, r.course_name].filter(Boolean).join(' \u203a ') || '\u2014';
  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 520 }}>
        <div className="ah"><h3><Ic k="rupee" />Receipt {r.receipt_no}</h3><button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button></div>
        <div className="abody">
          <div className="kv-grid">
            <div><span className="kl">Student</span><span className="kvv">{r.lead_name}</span></div>
            <div><span className="kl">Enrolment</span><span className="kvv">{r.enrolment_no}</span></div>
            <div><span className="kl">Amount</span><span className="kvv">{fmtINR(r.amount_minor)}</span></div>
            <div><span className="kl">Mode</span><span className="kvv">{String(r.mode).toUpperCase()}</span></div>
            <div><span className="kl">Reference</span><span className="kvv">{r.reference || '\u2014'}</span></div>
            <div><span className="kl">Received</span><span className="kvv">{dt(r.received_at)}</span></div>
            <div className="span2"><span className="kl">Branch › Vertical › Course</span><span className="kvv">{path}</span></div>
            {r.note ? <div className="span2"><span className="kl">Note</span><span className="kvv">{r.note}</span></div> : null}
          </div>
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={() => openPdf(`/fees/receipts/${r.id}/pdf`)}><Ic k="doc" />Download PDF</button>
        </div>
      </div>
    </div>
  );
}

export function FeeCollection() {
  const { can } = useAuth();
  // SHARED date range on the receipt date (received_at). Default All time.
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const fq = new URLSearchParams();
  if (range.from) fq.set('from', range.from);
  if (range.to) fq.set('to', range.to);
  const rangeKey = `${range.from ?? ''}~${range.to ?? ''}`;
  const { data, reload } = useFetch<any[]>('/fees/receipts' + (fq.toString() ? `?${fq}` : ''), [rangeKey]);
  const summary = useFetch<any>('/fees/summary');
  const [modal, setModal] = useState(false);
  const rows = data ?? [];
  const s = summary.data;
  const [viewRec, setViewRec] = useState<any | null>(null);
  const bump = () => { reload(); summary.reload(); };

  const del = async (r: any) => {
    if (!confirm(`Delete receipt ${r.receipt_no} for ${fmtINR(r.amount_minor)}? This is a correction, not a refund.`)) return;
    try { await api.del(`/fees/receipts/${r.id}`); toast('Receipt deleted'); bump(); }
    catch (e) { toast((e as Error).message); }
  };

  const total = (s?.by_mode ?? []).reduce((a: number, m: any) => a + m.total_minor, 0);

  return (
    <>
      {can('fee.collect') && (
        <div className="page-actions">
          <button className="btn primary" onClick={() => setModal(true)}><Ic k="plus" />Record payment</button>
        </div>
      )}
      <Kpis items={[
        { lab: 'Collected (MTD)', val: s ? fmtINR(s.mtd_minor) : '—', ic: 'rupee' },
        { lab: 'Today', val: s ? fmtINR(s.today_minor) : '—', ic: 'rupee' },
        { lab: 'Outstanding', val: s ? fmtINR(s.outstanding_minor) : '—', ic: 'clock' },
        { lab: 'Receipts', val: String(s?.receipts ?? 0), ic: 'doc' },
      ]} />
      <div className="filters" style={{ marginBottom: 12 }}>
        <DateRange value={range} onChange={setRange} idPrefix="fees-dr" />
      </div>
      <PhaseNote>
        This is <b>lite fee collection</b>: a receipt and a collection entry.
        <b> GST invoices, dues &amp; ageing, installment schedules, refunds and Razorpay capture are Phase 3.</b>
        <b> Outstanding</b> is net fee less cash received, across active enrolments — not an ageing report.
      </PhaseNote>
      <HBars title="Collection by mode"
        rows={(s?.by_mode ?? []).map((m: any) => ({
          label: `${m.label} — ${m.n} receipt${m.n === 1 ? '' : 's'}`,
          val: fmtINR(m.total_minor),
          pct: total > 0 ? Math.round((m.total_minor * 100) / total) : 0,
          color: 'var(--indigo)',
        }))}
        empty="No payments recorded yet" />
      <TableCard
        title="Fee Receipt Records" icon="rupee"
        cols={['Receipt', 'Student', 'Enrolment', 'Amount', 'Mode', 'Reference', 'Received', 'Branch \u203a Vertical \u203a Course', 'Actions']}
        empty="No payments recorded yet"
        rows={rows.map((r): Cell[] => [
          { node: <b className="mono">{r.receipt_no}</b> },
          r.lead_name,
          { mono: r.enrolment_no },
          { mono: fmtINR(r.amount_minor) },
          { b: [r.mode.toUpperCase(), 'b-indigo'] },
          r.reference ? { mono: r.reference } : '—',
          dt(r.received_at),
          { node: <span>{[r.branch_name, r.vertical_name, r.course_name].filter(Boolean).join(' \u203a ') || '—'}</span> },
          {
            node: <RowBtns items={[
              ['eye', 'View receipt', () => setViewRec(r)],
              ['doc', 'Download receipt PDF', () => openPdf(`/fees/receipts/${r.id}/pdf`)],
              ...(can('fee.delete') ? [['trash', 'Delete', () => void del(r)] as [string, string, () => void]] : []),
            ]} />,
          },
        ])}
      />
      {modal && <CollectModal onClose={() => setModal(false)} onSaved={bump} />}
      {viewRec && <ReceiptViewModal r={viewRec} onClose={() => setViewRec(null)} />}
    </>
  );
}

/* ==================================================================== */
/*  SETTINGS › NUMBERING SERIES                                          */
/* ==================================================================== */

/**
 * Numbering used to be a raw JSON textarea backed by `app_setting.numbering_series`.
 * Sprint 5 is the first thing that ALLOCATES from it, and allocation needs atomicity and
 * a row per branch / vertical — so the truth moved to the `number_series` TABLE and this
 * card is now the one place it is edited. Migration 029 carries the old JSON across and
 * DELETES the app_setting row: two places to edit one number is how you get two
 * different numbers.
 */
export function NumberingCard() {
  const { data, reload } = useFetch<any>('/numbering');
  const [edit, setEdit] = useState<any>(null);
  const series = data?.series ?? [];

  return (
    <div className="card">
      <div className="card-head">
        <h3><Ic k="doc" />Numbering series</h3>
        <button className="btn ghost sm" onClick={() => setEdit({ kind: 'quotation', prefix: '', next_number: 1, padding: 4, reset_period: 'yearly' })}>
          <Ic k="plus" />Add a branch / vertical series
        </button>
      </div>
      <div className="card-pad">
        <p className="sub" style={{ marginTop: 0 }}>
          Prefix and next number for quotations, enrolments and fee receipts (and invoices, which Phase 3 uses).
          A branch or vertical series overrides the org-wide one — <b>most specific wins</b>, the same rule
          the SLA policies and the channel credentials use.
        </p>
        <TableCard
          title="" icon="doc"
          cols={['Document', 'Scope', 'Next number looks like', 'Next #', 'Resets', '']}
          empty="No series configured"
          rows={series.map((s: any): Cell[] => [
            s.label,
            s.branch_name || s.vertical_name
              ? [s.branch_name, s.vertical_name].filter(Boolean).join(' · ')
              : { b: ['Org-wide (fallback)', 'b-gray'] },
            { mono: s.preview },
            String(s.next_number),
            s.reset_period === 'none' ? 'Never' : s.reset_period === 'yearly' ? 'Every year' : 'Every month',
            { node: <RowBtns items={[['pencil', 'Edit', () => setEdit(s)]]} /> },
          ])}
        />
      </div>
      {edit && <NumberingModal initial={edit} kinds={data?.kinds ?? []} onClose={() => setEdit(null)} onSaved={reload} />}
    </div>
  );
}

export function NumberingModal({ initial, kinds, onClose, onSaved }: {
  initial: any; kinds: Array<{ key: string; label: string }>; onClose: () => void; onSaved?: () => void;
}) {
  const ref = useRef_();
  const [kind, setKind] = useState(String(initial?.kind ?? 'quotation'));
  const [branchId, setBranchId] = useState(String(initial?.branch_id ?? ''));
  const [verticalId, setVerticalId] = useState(String(initial?.vertical_id ?? ''));
  const [prefix, setPrefix] = useState(String(initial?.prefix ?? ''));
  const [suffix, setSuffix] = useState(String(initial?.suffix ?? ''));
  const [next, setNext] = useState(String(initial?.next_number ?? 1));
  const [padding, setPadding] = useState(String(initial?.padding ?? 4));
  const [reset, setReset] = useState(String(initial?.reset_period ?? 'yearly'));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const preview = useMemo(() => {
    const tok = reset === 'yearly' ? String(new Date().getFullYear())
      : reset === 'monthly' ? `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}` : '';
    const n = String(Number(next) || 1).padStart(Math.max(0, Number(padding) || 0), '0');
    return `${prefix}${tok ? `${tok}/` : ''}${n}${suffix}`;
  }, [prefix, suffix, next, padding, reset]);

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.post('/numbering', {
        kind,
        branch_id: branchId ? Number(branchId) : null,
        vertical_id: verticalId ? Number(verticalId) : null,
        prefix, suffix,
        next_number: Number(next),
        padding: Number(padding),
        reset_period: reset,
      });
      toast('Numbering saved'); onSaved?.(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="add-scrim">
      <div className="add-modal" style={{ maxWidth: 640 }}>
        <div className="ah">
          <h3><Ic k="doc" />{initial?.id ? 'Edit numbering series' : 'New numbering series'}</h3>
          <button className="ax" onClick={onClose} aria-label="Close"><Ic k="x" /></button>
        </div>
        <div className="abody">
          <div className="form-grid">
            <div className="fld">
              <label htmlFor="n-kind">Document <span className="star">*</span></label>
              <select id="n-kind" className="ainp" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!initial?.id}>
                {(kinds.length ? kinds : [{ key: 'quotation', label: 'Quotations' }]).map((k) => (
                  <option key={k.key} value={k.key}>{k.label}</option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="n-reset">Reset the counter</label>
              <select id="n-reset" className="ainp" value={reset} onChange={(e) => setReset(e.target.value)}>
                <option value="none">Never</option>
                <option value="yearly">Every year</option>
                <option value="monthly">Every month</option>
              </select>
              <div className="fhint">The period is written into the number, so numbers stay unique across a reset.</div>
            </div>
            <div className="fld">
              <label htmlFor="n-branch">Branch</label>
              <select id="n-branch" className="ainp" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">All branches</option>
                {ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="n-vertical">Vertical</label>
              <select id="n-vertical" className="ainp" value={verticalId} onChange={(e) => setVerticalId(e.target.value)}>
                <option value="">All verticals</option>
                {ref.verticals.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <div className="fhint">Leave both blank for the org-wide fallback.</div>
            </div>
            <div className="fld">
              <label htmlFor="n-prefix">Prefix</label>
              <input id="n-prefix" className="ainp" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="QT-" />
            </div>
            <div className="fld">
              <label htmlFor="n-suffix">Suffix</label>
              <input id="n-suffix" className="ainp" value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="" />
            </div>
            <div className="fld">
              <label htmlFor="n-next">Next number <span className="star">*</span></label>
              <input id="n-next" className="ainp" type="number" min={1} value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="n-padding">Zero-padding</label>
              <input id="n-padding" className="ainp" type="number" min={0} max={12} value={padding}
                onChange={(e) => setPadding(e.target.value)} />
            </div>
            <div className="fld span2">
              <label htmlFor="n-preview">The next number will be</label>
              <input id="n-preview" className="ainp mono" value={preview} readOnly disabled />
            </div>
          </div>
          {err ? <div className="notice err" style={{ marginTop: 10 }}><Ic k="bolt" /><div>{err}</div></div> : null}
        </div>
        <div className="af">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== */
/*  SETTINGS › ENROLMENT APPROVALS                                       */
/* ==================================================================== */

/** The approval policy editor — the one row that turns approvals on. Default OFF. */
export function ApprovalPolicyCard() {
  const { data, reload } = useFetch<any>('/enrolments/approval-policy');
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<any>(null);
  useEffect(() => { setP(data ? JSON.parse(JSON.stringify(data)) : null); }, [data]);
  if (!p) return null;

  const save = async () => {
    setBusy(true);
    try { await api.post('/enrolments/approval-policy', p); toast('Approval policy saved'); reload(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const setStep = (key: string, patch: any) =>
    setP((x: any) => ({ ...x, steps: x.steps.map((s: any) => (s.key === key ? { ...s, ...patch } : s)) }));

  return (
    <div className="card">
      <div className="card-head"><h3><Ic k="check" />Enrolment approvals</h3></div>
      <div className="card-pad">
        <p className="sub" style={{ marginTop: 0 }}>
          Optional approval per step. <b>Off by default</b> — a counsellor closes a sale and it is closed.
          Switched on, the same closure lands in the approval queue instead: it does not count towards targets
          or revenue, and cannot take a fee, until a manager approves it. Branch and Vertical Managers approve;
          a counsellor cannot, and nobody can approve their own.
        </p>
        <div className="form-grid">
          <div className="fld">
            <label htmlFor="ap-enabled">Approvals</label>
            <select id="ap-enabled" className="ainp" value={p.enabled ? 'on' : 'off'}
              onChange={(e) => setP({ ...p, enabled: e.target.value === 'on' })}>
              <option value="off">Off — no approval needed</option>
              <option value="on">On — use the steps below</option>
            </select>
          </div>
        </div>
        {(p.steps ?? []).map((s: any) => (
          <div className="form-grid" key={s.key} style={{ opacity: p.enabled ? 1 : 0.5 }}>
            <div className="fld">
              <label htmlFor={`ap-${s.key}`}>{s.label}</label>
              <select id={`ap-${s.key}`} className="ainp" value={s.enabled ? 'on' : 'off'}
                onChange={(e) => setStep(s.key, { enabled: e.target.value === 'on' })} disabled={!p.enabled}>
                <option value="off">Not required</option>
                <option value="on">Requires approval</option>
              </select>
              <div className="fhint">Approvers: {(s.roles ?? []).join(', ') || '—'}</div>
            </div>
            {s.key === 'discount' && (
              <div className="fld">
                <label htmlFor="ap-thresh">…when the discount is above (%)</label>
                <input id="ap-thresh" className="ainp" type="number" min={0} max={100}
                  value={String(s.discount_pct_over ?? 10)} disabled={!p.enabled}
                  onChange={(e) => setStep('discount', { discount_pct_over: Number(e.target.value) })} />
                <div className="fhint">Strictly above — a discount of exactly this much does not need a nod.</div>
              </div>
            )}
          </div>
        ))}
        <button className="btn primary" disabled={busy} onClick={save}><Ic k="check" />{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
