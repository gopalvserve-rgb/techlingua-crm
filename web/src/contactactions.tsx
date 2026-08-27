/**
 * ContactQuickActions (dev/142) — a single reusable, compact set of contact quick-action
 * icons for a lead/contact: Phone (tel:), Copy (clipboard + "Copied" toast), WhatsApp
 * (wa.me) and Note (opens the existing add-note flow via an onNote callback). Icon-only
 * with tooltips; each action stops row-click propagation so it can live inside a clickable
 * lead row without also opening the lead. Dropped into the Leads list row, Start Calling
 * queue row and Today's Follow-up rows so contact actions are consistent everywhere.
 * marker: contact-quick-actions
 */
import type { MouseEvent } from 'react';
import { Ic } from './icons';
import { toast } from './refdata';

/** Numerals only — mirrors the existing wa.me / tel handling (strip spaces, '+', punctuation). */
export function phoneDigits(phone?: string | null): string {
  return String(phone ?? '').replace(/[^\d]/g, '');
}

/** Clipboard copy with a graceful fallback for browsers without the async Clipboard API. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy execCommand path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

export function ContactQuickActions({ phone, whatsapp, onNote, className }: {
  phone?: string | null;
  whatsapp?: string | null;
  onNote?: () => void;
  className?: string;
}) {
  const tel = phoneDigits(phone);
  const wa = phoneDigits(whatsapp || phone);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const doCopy = async (e: MouseEvent) => {
    stop(e);
    const raw = String(phone ?? '').trim();
    if (!raw) { toast('No phone number on this contact', true); return; }
    const ok = await copyToClipboard(raw);
    toast(ok ? 'Copied' : 'Copy failed', !ok);
  };
  return (
    <span className={`cqa${className ? ` ${className}` : ''}`} data-testid="contact-quick-actions" onClick={stop}>
      {tel
        ? <a className="cqa-ic call" title="Call" aria-label="Call" href={`tel:+${tel}`} onClick={stop}><Ic k="calls" /></a>
        : null}
      <button type="button" className="cqa-ic" title="Copy number" aria-label="Copy number"
        onClick={doCopy} disabled={!tel}><Ic k="copy" /></button>
      {wa
        ? <a className="cqa-ic wa" title="WhatsApp" aria-label="WhatsApp" href={`https://wa.me/${wa}`}
            target="_blank" rel="noreferrer" onClick={stop}><Ic k="wa" /></a>
        : null}
      {onNote
        ? <button type="button" className="cqa-ic" title="Add note" aria-label="Add note"
            onClick={(e) => { stop(e); onNote(); }}><Ic k="note" /></button>
        : null}
    </span>
  );
}
